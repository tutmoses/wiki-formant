// og.tsx — the social card every wiki renders at `/og`, as the element tree
// `next/og`'s ImageResponse takes. The package owns the frame: the size, the
// cache window, the type scale, the clipping (`describe`, as a meta description
// is fitted) and the satori traps. Each site owns its colours, its fonts and,
// if it wants one, its own artwork.
//
// Two wikis had written the same card, seeded gradient and translucent circles
// under a bottom-aligned title, and a third had settled for a static one. What
// they shared was the frame; what differed was the palette and the art, so
// those are arguments.
//
// satori is not a browser, and three of its rules shape this file:
//   - every element with more than one child needs `display: flex`;
//   - a style key set to `undefined` throws mid-render rather than being
//     skipped, so optional styles are spread in or left out, never assigned;
//   - no CSS variables and no color-mix(): colours arrive as flat values.
// Fonts stay with the caller: Next traces a font file into a function only from
// a literal path in the app's own code, which a package cannot name.

import type { ReactElement, ReactNode } from 'react';
import { describe } from './metadata.js';
import { hashStr, seededRandom } from './seeded.js';

export const OG_SIZE = { width: 1200, height: 630 } as const;

/** A day at the CDN, a week stale: a card changes when its page's title does, and crawlers cache it for longer anyway. */
export const OG_HEADERS = { 'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800' } as const;

/** The card's generator, seeded from its text, so one page always draws the same card. */
export function cardRandom(...parts: string[]): () => number {
  return seededRandom(hashStr(parts.join('')));
}

export interface BubbleOptions {
  /** The two ends of the field's gradient; its angle is seeded. */
  field: readonly [string, string];
  /** Circle colours, picked at random per circle. */
  colors: readonly string[];
  count?: number;
  /** Smallest radius and the spread above it, in px. */
  radius?: readonly [number, number];
  /** Lowest opacity and the spread above it. */
  opacity?: readonly [number, number];
}

/** The seeded gradient and translucent circles: a field and its art, for `SocialCard`. */
export function bubbles(rand: () => number, o: BubbleOptions): { background: string; art: ReactNode } {
  const [r0, rSpan] = o.radius ?? [60, 180];
  const [a0, aSpan] = o.opacity ?? [0.12, 0.2];
  const background = `linear-gradient(${Math.floor(rand() * 360)}deg, ${o.field[0]}, ${o.field[1]})`;
  const art = Array.from({ length: o.count ?? 7 }, (_, i) => {
    const cx = rand() * OG_SIZE.width;
    const cy = rand() * OG_SIZE.height;
    const r = r0 + rand() * rSpan;
    const color = o.colors[Math.floor(rand() * o.colors.length)] ?? o.field[1];
    return (
      <div key={i} style={{ position: 'absolute', left: cx - r, top: cy - r, width: r * 2, height: r * 2, borderRadius: '50%', background: color, opacity: a0 + rand() * aSpan }} />
    );
  });
  return { background, art };
}

export interface SocialCardProps {
  title: string;
  /** The line above the title: a section, a code, a handle. */
  eyebrow?: string;
  /** The line along the foot. */
  description?: string;
  /** The site's name, at the foot's right. */
  mark?: string;
  colors: {
    text: string;
    /** The description. */
    muted: string;
    /** The eyebrow and the mark. */
    accent: string;
  };
  /** The field: any CSS background satori draws, a gradient from `bubbles` or a flat colour. */
  background: string;
  /** Absolutely positioned layers between the field and the text. */
  art?: ReactNode;
  /** A dark gradient up from the foot, for art that is a photograph. */
  scrim?: boolean;
  fontFamily?: string;
  /** Anything that belongs under the title: chips, a figure. */
  children?: ReactNode;
}

const SCRIM = 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.3) 50%, transparent 100%)';

/** One card, 1200×630: the eyebrow, title and anything under it, then the description and the mark along the foot. */
export function SocialCard(p: SocialCardProps): ReactElement {
  const title = describe(p.title, 90);
  // Three lines at most at either size; the step is where 68px would wrap a fourth.
  const titleSize = title.length > 48 ? 56 : 72;
  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', position: 'relative', background: p.background, ...(p.fontFamily ? { fontFamily: p.fontFamily } : {}) }}>
      {p.art}
      <div
        style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
          width: '100%', height: '100%', padding: '56px 64px', position: 'relative',
          ...(p.scrim ? { background: SCRIM } : {}),
        }}
      >
        {p.eyebrow ? <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, color: p.colors.accent, marginBottom: 14 }}>{describe(p.eyebrow, 48)}</div> : null}
        <div style={{ display: 'flex', fontSize: titleSize, fontWeight: 700, color: p.colors.text, lineHeight: 1.08, letterSpacing: '-0.02em' }}>{title}</div>
        {p.children ? <div style={{ display: 'flex', marginTop: 28 }}>{p.children}</div> : null}
        {p.description || p.mark ? (
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 40, marginTop: 28 }}>
            <div style={{ display: 'flex', flex: 1, fontSize: 26, lineHeight: 1.35, color: p.colors.muted }}>{p.description ? describe(p.description, 110) : ''}</div>
            {p.mark ? <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, color: p.colors.accent }}>{p.mark}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
