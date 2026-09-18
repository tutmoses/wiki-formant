// corpus.ts — a wiki's whole corpus, sliced to something a tool result can hold.
//
// /llms-full.txt can afford to be 3 MB: a fetch streams to disk under an ETag.
// A tool result lands in a context window, so the MCP twin of that export needs
// a preflight, a character budget and a page-aligned resume. Two wikis wrote
// that loop and called the second a copy of the first "field for field". It was
// not: the fields had different names, one reported `truncated: false` after
// clipping the last page — while its own prompt told agents to page until
// `truncated` was false — and the other sized its preflight on page bodies but
// sliced on whole sections, so the preflight undercounted what it would send.
//
// The corpus itself — which rows, in what order, how a page becomes a section —
// stays with each wiki. This is the arithmetic over the sections it hands in.

/** One page as it appears in the document. */
export interface CorpusSection {
  /** The page's address, `tag/path/slug`. */
  path: string;
  /** Its branch, for the preflight's per-branch breakdown. */
  tagPath: string;
  /** Heading, URL, date and body, exactly as the document will carry them. */
  section: string;
}

/** `maxChars` bounds: the default, the floor and the ceiling. Quote them in the tool's schema. */
export const CORPUS_BUDGET = { default: 200_000, min: 1_000, max: 1_000_000 } as const;

export interface CorpusSliceOptions {
  /** The returned document's heading. */
  title: string;
  /** Sizes and breakdowns only, no document. */
  sizeOnly?: boolean;
  /** First section to include: the previous call's `nextSkip`. */
  skip?: number;
  /** Character budget for `document`. */
  maxChars?: number;
  /** The preflight's closing advice: what is cheaper than pulling everything. */
  hint?: string;
}

const CLIP_MARKER = '\n\n[…page clipped at maxChars…]';

/**
 * A preflight (`sizeOnly`) or one page-aligned slice of `sections`.
 *
 * `truncated` is true whenever content was cut: whole pages left over, or one
 * page clipped mid-way because it alone exceeds the budget. `nextSkip` appears
 * only when paging forward can return something; a clipped page is skipped
 * past, since resuming on it would stall paging forever.
 */
export function sliceCorpus(sections: readonly CorpusSection[], opts: CorpusSliceOptions) {
  const { title, sizeOnly = false, skip = 0, maxChars = CORPUS_BUDGET.default, hint } = opts;
  const characters = sections.reduce((n, s) => n + s.section.length, 0);
  const head = {
    totalPages: sections.length,
    characters,
    estimatedTokens: Math.round(characters / 4),
    tokenNote: 'estimatedTokens is characters/4, a rough guide only.',
  };

  if (sizeOnly) {
    const branches = new Map<string, { pages: number; chars: number }>();
    for (const s of sections) {
      const b = branches.get(s.tagPath) ?? { pages: 0, chars: 0 };
      branches.set(s.tagPath, { pages: b.pages + 1, chars: b.chars + s.section.length });
    }
    return {
      ...head,
      branches: [...branches.entries()].map(([path, b]) => ({ path, ...b })).sort((a, b) => b.chars - a.chars),
      largestPages: sections
        .map(s => ({ path: s.path, chars: s.section.length }))
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 5),
      hint: hint ?? 'Pull with maxChars, or one branch at a time with tagPath.',
    };
  }

  const parts: string[] = [];
  let used = 0;
  let index = skip;
  let clippedPage: string | undefined;
  for (; index < sections.length; index++) {
    const s = sections[index]!;
    if (used + s.section.length > maxChars) {
      if (!parts.length) {
        parts.push(`${s.section.slice(0, maxChars)}${CLIP_MARKER}`);
        clippedPage = s.path;
        used = maxChars;
        index++;
      }
      break;
    }
    parts.push(s.section);
    used += s.section.length;
  }
  const morePages = index < sections.length;

  return {
    ...head,
    skip,
    includedPages: parts.length,
    omittedPages: sections.length - index,
    returnedCharacters: used,
    truncated: morePages || clippedPage !== undefined,
    ...(morePages ? { nextSkip: index } : {}),
    ...(clippedPage
      ? { clippedPage, clippedHint: 'This page alone exceeds maxChars; raise maxChars to read the rest of it.' }
      : {}),
    document: [`# ${title}\n\n> pages ${skip + 1}-${index} of ${sections.length}`, ...parts].join('\n\n'),
  };
}
