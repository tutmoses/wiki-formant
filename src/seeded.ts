// seeded.ts — deterministic pseudo-randomness, for art that must not move.
//
// Both wikis generate SVG from a title: a page banner, a fallback icon. The
// mark has to be identical on the server and in the browser and on the next
// render forever, so `Math.random` is not available to them and these two are
// what they use instead. Both had written the same pair, and the comment in one
// of them recorded that its two guards had been ported from the other — which
// is a copy documenting itself as a copy.

/** djb2-ish, 32-bit, non-negative. Stable across processes and runtimes. */
export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Lehmer/Park-Miller, seeded by an integer.
 *
 * Both guards matter and neither is obvious. Without the modulo a seed can
 * exceed the modulus; without the `<= 0` correction a seed of 0 sticks the
 * generator at 0 forever — every call returns the same number and whatever it
 * was laying out degenerates to a single point.
 */
export function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}
