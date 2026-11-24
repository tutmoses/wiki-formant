// highlight.ts – where a search's words fall in a result's text, matched the way
// the search matched them: case and accents ignored (`jiang` finds `jiāng`), a
// hyphenated word as its parts (`fullTextQuery`), each word anywhere (the
// literal tiers' ILIKE), and its stem at the start of a word (the full-text
// tier's stemming: `needles` marks `needle`). A word every page has marks
// nothing, as the full-text tier drops it.

const STOP_WORDS = new Set(
  'a an and are as at be but by can do does for from has have how i if in into is it its of on or so than that the their then there these this to was were what when where which who why will with you your'.split(' '),
);

const WORD = /[\p{L}\p{N}]/u;

interface Folded {
  folded: string;
  /** For each code unit of `folded`, where its character starts and ends in the original. */
  starts: number[];
  ends: number[];
}

/** `text` lower-cased and stripped of accents, mapped back to the original's offsets. */
function fold(text: string): Folded {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const f = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + char.length);
    }
    folded += f;
    i += char.length;
  }
  return { folded, starts, ends };
}

/**
 * The words of `query` a result is marked for, folded, longest first: no
 * excluded `-word`, no stop word, no lone Latin letter or digit while a longer
 * word is there. A query of nothing but such words keeps them all.
 */
export function searchTerms(query: string): string[] {
  const words = fold(query.replace(/([\p{L}\p{N}])[-_]+(?=[\p{L}\p{N}])/gu, '$1 '))
    .folded.split(/\s+/)
    .filter(w => !w.startsWith('-'))
    .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  const kept = words.filter(w => !STOP_WORDS.has(w) && !/^[a-z0-9]$/.test(w));
  return [...new Set(kept.length ? kept : words)].sort((a, b) => b.length - a.length);
}

/** A word's stem as the full-text tier reads it, or the word itself when it is short. */
const stem = (word: string): string =>
  word.length >= 5 ? word.replace(/(?:ing|ed|es|s|y)$/, '') : word.length === 4 ? word.replace(/s$/, '') : word;

/**
 * The `[start, end)` ranges of `text` that `query` matched, in order and never
 * overlapping: each term wherever it occurs, and each term's stem at the start
 * of a word, marked to the end of that word.
 */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
  const terms = searchTerms(query);
  if (!terms.length || !text) return [];
  const { folded, starts, ends } = fold(text);
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    for (let i = folded.indexOf(term); i !== -1; i = folded.indexOf(term, i + 1)) marks.push([i, i + term.length]);
    const root = stem(term);
    if (root === term) continue;
    for (let i = folded.indexOf(root); i !== -1; i = folded.indexOf(root, i + 1)) {
      if (i > 0 && WORD.test(folded[i - 1]!)) continue;
      let end = i + root.length;
      while (end < folded.length && WORD.test(folded[end]!)) end++;
      marks.push([i, end]);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of marks) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => [starts[s]!, ends[e - 1]!]);
}
