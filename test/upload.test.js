import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeImage, uploadHandler } from 'wiki-formant/upload';
import { resetRateLimits } from 'wiki-formant/rate-limit';

const png = (w = 8, h = 8) => sharp({ create: { width: w, height: h, channels: 3, background: '#c06a73' } }).png().toBuffer();
const post = (bytes, name = 'a.png', type = 'image/png', ip = '1.1.1.1') => {
  const form = new FormData();
  if (bytes) form.append('file', new File([bytes], name, { type }));
  return new Request('https://x/api/upload', { method: 'POST', body: form, headers: { 'x-real-ip': ip } });
};
const harness = (opts = {}) => {
  const stored = [];
  const handler = uploadHandler({
    authorize: async () => 'u1',
    store: async (path, body, contentType) => (stored.push({ path, body, contentType }), `https://blob/${path}`),
    ...opts,
  });
  return { handler, stored };
};
const error = async res => (await res.json()).error;

test('an image is re-encoded in its own format and stored under a fresh name', async () => {
  resetRateLimits();
  const { handler, stored } = harness({ prefix: 'wiki/' });
  const res = await handler(post(await png()));
  assert.equal(res.status, 200);
  const { url } = await res.json();
  assert.match(url, /^https:\/\/blob\/wiki\/[0-9a-f-]{36}\.png$/);
  assert.equal(stored[0].contentType, 'image/png');
  assert.equal((await sharp(stored[0].body).metadata()).format, 'png');
});

test('the refusal from authorize is the answer, and nothing is stored', async () => {
  const { handler, stored } = harness({ authorize: async () => Response.json({ error: 'Sign in to upload.' }, { status: 401 }) });
  const res = await handler(post(await png()));
  assert.equal(res.status, 401);
  assert.equal(stored.length, 0);
});

test('the file is judged by its bytes, not by the name or type it claims', async () => {
  resetRateLimits();
  const { handler, stored } = harness();
  const res = await handler(post(Buffer.from('<svg onload=alert(1)>'), 'x.png', 'image/png'));
  assert.equal(res.status, 400);
  assert.match(await error(res), /Invalid file/);
  assert.equal((await handler(post(null))).status, 400, 'no file');
  assert.equal(stored.length, 0);
});

test('bytes and decoded pixels are both capped', async () => {
  resetRateLimits();
  const { handler } = harness({ maxBytes: 64 * 1024, maxPixels: 10_000 });
  const big = await handler(post(Buffer.alloc(65 * 1024, 1)));
  assert.match(await error(big), /File too large \(max 0\.1MB\)/);
  const wide = await handler(post(await png(200, 200)));
  assert.equal(wide.status, 400);
  assert.match(await error(wide), /Image too large/);
});

test('location metadata does not survive, and the orientation it carried is applied', async () => {
  resetRateLimits();
  const { handler, stored } = harness();
  const jpeg = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#fff' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Make: 'Phone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } })
    .toBuffer();
  assert.ok((await sharp(jpeg).metadata()).exif, 'the fixture carries EXIF');
  assert.equal((await handler(post(jpeg, 'p.jpg', 'image/jpeg'))).status, 200);
  const meta = await sharp(stored[0].body).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [10, 20], 'rotated upright before the tag went');
  assert.match(stored[0].path, /\.jpg$/);
});

test('encode can convert, and the stored name and type follow it', async () => {
  resetRateLimits();
  const { handler, stored } = harness({
    encode: (image, { width }) => ({ image: (width > 4 ? image.resize({ width: 4 }) : image).webp(), format: 'webp' }),
  });
  assert.equal((await handler(post(await png(16, 16)))).status, 200);
  assert.equal(stored[0].contentType, 'image/webp');
  assert.match(stored[0].path, /\.webp$/);
  assert.equal((await sharp(stored[0].body).metadata()).width, 4);
});

test('each uploader has a budget', async () => {
  resetRateLimits();
  const { handler } = harness({ rateLimit: { capacity: 1, refillPerSec: 0.001 } });
  assert.equal((await handler(post(await png()))).status, 200);
  const refused = await handler(post(await png()));
  assert.equal(refused.status, 429);
  assert.ok(refused.headers.get('Retry-After'));
});

test('normalizeImage is the same check without the route, its refusals thrown', async () => {
  const out = await normalizeImage(await png());
  assert.deepEqual([out.format, out.contentType], ['png', 'image/png']);
  await assert.rejects(normalizeImage(Buffer.from('<svg onload=alert(1)>')), /Invalid file/);
  await assert.rejects(normalizeImage(await png(200, 200), { maxPixels: 10_000 }), /Image too large/);
});
