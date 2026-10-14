// upload.ts — the route an editor's image upload posts to.
//
// radix-wiki and caper had each written it, and their limits had drifted apart:
// one took 25 MB with no cap on decoded pixels and trusted the client's
// Content-Type, the other 4 MB, 40 megapixels and the file's own leading bytes.
// This is the second, with the first one's re-encode as an option.
//
// - **The bytes say what the file is.** The Content-Type and the name are the
//   caller's to choose, and trusting them stores arbitrary bytes under an image
//   URL, served with a spoofed type. SVG is not accepted: it is markup.
// - **Pixels are capped as well as bytes.** A PNG well under the byte limit can
//   decode to gigabytes.
// - **Every image is re-encoded, never stored as sent.** Re-encoding writes
//   none of the source's metadata, and with it no GPS position from a phone's
//   EXIF; the orientation that metadata carried is applied first.
// - **Each uploader has a budget**, keyed on who they are and where from.
//
// `sharp` and `@vercel/blob` are optional peers. Run the route on Node, never
// the edge: sharp is native.

import sharp, { type Sharp } from 'sharp';
import { put } from '@vercel/blob';
import { errors, handleRoute, json } from './http.js';
import { limitClient, type RateLimitOptions } from './rate-limit.js';

export type ImageFormat = 'jpg' | 'png' | 'gif' | 'webp' | 'avif';

const CONTENT_TYPE: Record<ImageFormat, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** The format the leading bytes declare, or null for anything not an accepted image. */
function sniffImage(buf: Uint8Array): ImageFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'avif';
  return null;
}

export interface UploadOptions {
  /** The uploader's id, which keys the rate limit, or the response that turns them away. */
  authorize: (request: Request) => Promise<string | Response>;
  /** Default 4 MB. */
  maxBytes?: number;
  /** Decoded pixels, default 40 million: a phone camera's full resolution. */
  maxPixels?: number;
  /** Default a burst of 20, then one every five seconds. */
  rateLimit?: RateLimitOptions;
  /**
   * How the upright image is written. Default the format it arrived in. A wiki
   * with an image standard resizes and converts here.
   */
  encode?: (image: Sharp, source: { format: ImageFormat; width: number; height: number }) => {
    image: Sharp;
    format: ImageFormat;
  };
  /** Prepended to the stored name, e.g. `wiki/`. */
  prefix?: string;
  /** Stores the bytes and resolves to their public URL. Default Vercel Blob, public. */
  store?: (path: string, body: Buffer, contentType: string) => Promise<string>;
}

const vercelBlob = async (path: string, body: Buffer, contentType: string) =>
  (await put(path, body, { access: 'public', addRandomSuffix: false, contentType })).url;

/** The POST handler: a multipart `file` in, `{ url }` out. */
export function uploadHandler({
  authorize,
  maxBytes = 4 * 1024 * 1024,
  maxPixels = 40_000_000,
  rateLimit = { capacity: 20, refillPerSec: 0.2 },
  encode = (image, { format }) => ({ image: image.toFormat(format === 'jpg' ? 'jpeg' : format), format }),
  prefix = '',
  store = vercelBlob,
}: UploadOptions): (request: Request) => Promise<Response> {
  const megabytes = Math.round((maxBytes / 1024 / 1024) * 10) / 10;
  const megapixels = Math.round(maxPixels / 1_000_000);

  return request =>
    handleRoute(async () => {
      const who = await authorize(request);
      if (who instanceof Response) return who;

      const limit = limitClient(`upload:${who}`, request.headers, rateLimit);
      if (!limit.ok) {
        return errors.tooManyRequests(limit.retryAfterSec, `Too many uploads. Try again in ${limit.retryAfterSec}s.`);
      }

      const file = (await request.formData()).get('file');
      if (!(file instanceof File)) return errors.badRequest('No file provided');
      if (file.size > maxBytes) return errors.badRequest(`File too large (max ${megabytes}MB)`);

      const bytes = Buffer.from(await file.arrayBuffer());
      const format = sniffImage(bytes);
      if (!format) return errors.badRequest('Invalid file. Allowed: JPEG, PNG, GIF, WebP, AVIF');

      let out: { buffer: Buffer; format: ImageFormat };
      try {
        const meta = await sharp(bytes, { limitInputPixels: maxPixels }).metadata();
        const width = meta.width ?? 0;
        const height = meta.pageHeight ?? meta.height ?? 0;
        if (!width || !height) throw new Error('no dimensions');
        if (width * height > maxPixels) return errors.badRequest(`Image too large (max ${megapixels} megapixels)`);
        const upright = sharp(bytes, { animated: (meta.pages ?? 1) > 1, limitInputPixels: maxPixels }).rotate();
        const encoded = encode(upright, { format, width, height });
        out = { buffer: await encoded.image.toBuffer(), format: encoded.format };
      } catch (e) {
        // Never fall back to the bytes as sent: storing them is what leaks the location.
        const tooBig = e instanceof Error && e.message.includes('pixel limit');
        return errors.badRequest(
          tooBig
            ? `Image too large (max ${megapixels} megapixels)`
            : 'Could not read this image. Save it as PNG or JPEG and try again.',
        );
      }

      const url = await store(`${prefix}${crypto.randomUUID()}.${out.format}`, out.buffer, CONTENT_TYPE[out.format]);
      return json({ url });
    }, 'Upload failed');
}
