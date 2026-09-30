// history.ts – what changed between revisions, as a history view draws it.
//
// `revisions.ts` decides which bump a save asks for and stays free of
// dependencies, because every write path imports it. This is the reading half:
// the same walk, turned into what a reviewer is shown. It needs a text diff, so
// it needs `fast-diff`, an optional peer; hence its own subpath.
//
// radix-wiki had it first and shipped both HTML bodies of every modified block
// to the browser to diff there: 887 KB of payload for a 13-revision page whose
// drawn diffs came to 25 KB. The other two wikis showed a revision's message
// and nothing of what it changed.

import fastDiff from 'fast-diff';
import { diffBlocks, extractBlocks, type BlockChange, type BlockGroup, type DiffBlock } from './revisions.js';
import { coreBlockGroups } from './blocks.js';
import { stripHtml } from './text.js';

/** A stretch of text: -1 struck, 0 kept, 1 added. */
export type DiffPart = [-1 | 0 | 1, string];

/** A change as a history view lists it: the diff it draws, not the two bodies behind it. */
export type HistoryChange = BlockChange<DiffPart[]>;

/** Kept text is context, so a run longer than this keeps only its ends. */
const KEPT_MAX = 60;
const clip = (t: string) => (t.length > KEPT_MAX ? `${t.slice(0, 30)}…${t.slice(-30)}` : t);

/**
 * Two HTML bodies as the words struck and added between them, or `undefined`
 * when their text is the same. Semantic cleanup is on: without it a rewritten
 * sentence comes out as fragments of the letters the two versions share.
 */
export function textDiff(from: string, to: string): DiffPart[] | undefined {
  const a = stripHtml(from);
  const b = stripHtml(to);
  if (a === b) return undefined;
  const parts = fastDiff(a, b, undefined, true)
    .filter(([, t]) => t.trim())
    .map(([op, t]): DiffPart => [op, op === 0 ? clip(t) : t]);
  return parts.length ? parts : undefined;
}

export interface HistoryOptions<B> {
  /** Defaults to `coreBlockGroups`, as in `diffBlocks`. */
  containers?: (block: B) => BlockGroup<B>[] | null;
  /**
   * The HTML a leaf's diff is drawn from, or `undefined` for a block with no
   * prose. Defaults to a `content` block's `text`, the core model's one prose leaf.
   */
  leafText?: (block: B) => string | undefined;
}

const contentText = (block: DiffBlock): string | undefined =>
  block.type === 'content' ? (block as DiffBlock & { text?: string }).text : undefined;

/**
 * What changed between two versions of a page, leaves only: a container's own
 * entry restates its children. A leaf whose type changed is a replacement, and
 * one side's text against the other's would read as an edit, so it gets none.
 */
export function historyChanges<B extends DiffBlock>(
  oldContent: readonly B[],
  newContent: readonly B[],
  opts: HistoryOptions<B> = {},
): HistoryChange[] {
  const containers = opts.containers ?? coreBlockGroups<B>;
  const leafText = opts.leafText ?? contentText;
  const containerIds = new Set(
    [...extractBlocks(oldContent, containers), ...extractBlocks(newContent, containers)]
      .filter(({ block }) => containers(block))
      .map(({ block }) => block.id),
  );
  return diffBlocks<B, DiffPart[]>(oldContent, newContent, {
    containers,
    leafDiff: (from, to) => {
      const a = from ? leafText(from) : '';
      const b = to ? leafText(to) : '';
      return a === undefined || b === undefined ? undefined : textDiff(a, b);
    },
  }).filter(c => !containerIds.has(c.id));
}

/**
 * A page's revisions, newest first, each carrying what changed against the one
 * after it in the list and without the content it was diffed from. The last is
 * diffed against an empty page, so a caller showing a window of the history
 * passes one revision more than it shows and drops the last result.
 */
export function withChanges<R extends { content: unknown }, B extends DiffBlock = DiffBlock>(
  revisions: readonly R[],
  opts: HistoryOptions<B> = {},
): (Omit<R, 'content'> & { changes: HistoryChange[] })[] {
  const blocks = (r: R | undefined) => ((r?.content ?? []) as readonly B[]);
  return revisions.map((revision, i) => {
    const { content: _, ...rest } = revision;
    return { ...rest, changes: historyChanges(blocks(revisions[i + 1]), blocks(revision), opts) };
  });
}
