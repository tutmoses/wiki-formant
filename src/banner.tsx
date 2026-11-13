// banner.tsx — the banner a wiki page is headed with: its own picture, or art
// seeded by the page, so a page without a picture still has one and it is the
// same art on every render, on the server and in the browser.
//
// The art is inline SVG with a class per role rather than a data-URI image, so
// it takes the page's own custom properties: a themed site, a section's band
// and a category's palette are all CSS. No hooks and no directive, so a client
// island draws a card's thumbnail with the same component a server component
// draws the page's header with.

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { hashStr, seededRandom } from './seeded.js';

const W = 800;
const H = 200;

const px = (v: number) => Math.round(v);
const op = (v: number) => v.toFixed(2);

/**
 * The art's third kind of shape, as a path: a wiki's own mark. Given its
 * anchor, its size and the generator, so a mark that turns draws its turn
 * from the same sequence. The default is a triangle round the anchor.
 */
export type BannerMark = (x: number, y: number, size: number, rand: () => number) => string;

const triangle: BannerMark = (x, y, s, rand) =>
  `M${Array.from({ length: 3 }, () => `${px(x + rand() * s * 2 - s)} ${px(y + rand() * s * 2 - s)}`).join('L')}Z`;

// Static strings, so a class checker sees every one.
const FILL = ['banner-art__mid', 'banner-art__ink'] as const;
const LINE = ['banner-art__mid-line', 'banner-art__ink-line'] as const;

/**
 * The seeded field: a gradient at a seeded angle, three soft blobs, five to
 * eight shapes, four bright dots. Its colours are custom properties
 * (`base.css`): `--banner-from` and `--banner-to` the gradient, transparent
 * unless set, `--banner-mid` the blobs and half the shapes, `--banner-ink`
 * the other half and the dots.
 */
export function BannerArt({ seed, mark = triangle, className = 'banner-art' }: { seed: string; mark?: BannerMark; className?: string }): ReactElement {
  const hash = hashStr(seed);
  const rand = seededRandom(hash);
  const id = `banner-${hash.toString(36)}`;
  const shapes: ReactNode[] = [];

  const angle = Math.floor(rand() * 360);
  for (let i = 0; i < 3; i++) {
    shapes.push(<circle key={`blob${i}`} className={FILL[0]} cx={px(rand() * W)} cy={px(rand() * H)} r={px(60 + rand() * 120)} opacity={op(0.15 + rand() * 0.2)} />);
  }

  const count = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const tone = i % 2 === 0 ? 1 : 0;
    const opacity = op(0.12 + rand() * 0.25);
    const kind = Math.floor(rand() * 4);
    const key = `shape${i}`;
    if (kind === 0) {
      shapes.push(<circle key={key} className={FILL[tone]} cx={px(x)} cy={px(y)} r={px(8 + rand() * 40)} opacity={opacity} />);
    } else if (kind === 1) {
      const w = px(20 + rand() * 80), h = px(15 + rand() * 50), rx = px(rand() * 12);
      const turn = px(rand() * 60 - 30);
      shapes.push(<rect key={key} className={FILL[tone]} x={px(x)} y={px(y)} width={w} height={h} rx={rx} opacity={opacity} transform={`rotate(${turn} ${px(x)} ${px(y)})`} />);
    } else if (kind === 2) {
      shapes.push(<path key={key} className={FILL[tone]} d={mark(x, y, 15 + rand() * 35, rand)} opacity={opacity} />);
    } else {
      const r = px(12 + rand() * 30);
      shapes.push(<circle key={key} className={LINE[tone]} cx={px(x)} cy={px(y)} r={r} strokeWidth={(2 + rand() * 4).toFixed(1)} opacity={opacity} />);
    }
  }

  for (let i = 0; i < 4; i++) {
    shapes.push(<circle key={`dot${i}`} className={FILL[1]} cx={px(rand() * W)} cy={px(rand() * H)} r={px(2 + rand() * 6)} opacity={op(0.4 + rand() * 0.4)} />);
  }

  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} gradientTransform={`rotate(${angle})`}>
          <stop offset="0%" className="banner-art__from" />
          <stop offset="100%" className="banner-art__to" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id})`} />
      {shapes}
    </svg>
  );
}

/**
 * A page's header: its picture, else its art, with the page's trail and title
 * over it. `picture` is the app's own image element (`next/image` with `fill`,
 * say), since this package has no `next`; it fills the frame. The frame's
 * height is a floor of 4:1 that grows with what sits on it (`base.css`), so a
 * long title on a phone never loses its trail. `style` carries a palette's
 * custom properties.
 */
export function PageBanner({ seed, picture, mark, className, style, children }: { seed: string; picture?: ReactNode; mark?: BannerMark; className?: string; style?: CSSProperties; children?: ReactNode }): ReactElement {
  return (
    <div className={className ? `page-banner ${className}` : 'page-banner'} style={style}>
      {picture ?? <BannerArt seed={seed} mark={mark} />}
      {children && <div className="page-banner__body">{children}</div>}
    </div>
  );
}
