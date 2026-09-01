// revisions.ts — what changed between two versions of a page.
//
// The semver lives next door in `versioning.ts`; this is the walk that decides
// which bump to ask for. Both wikis had written it, and `extractBlocks` was
// byte-identical between the two copies.
//
// They differed in what each had learned since. One grew a leaf-level diff, a
// second changed-flag for the page's banner, and a `patch` classification for
// when only that flag moved. The other grew none of those and instead dropped
// twenty-five lines the first still carries: two Maps keyed by a recursive
// JSON.stringify of every block, built on every save and never read once.
// Matching is by id and always was.
//
// This is the union, minus the dead half.

import { incrementVersion, parseVersion, type ChangeType, type SemVer } from './versioning.js';

/** The only two fields this module needs from a block. */
export interface DiffBlock {
  id: string;
  type: string;
}

/**
 * One nested group, with the path segment that addresses it.
 *
 * The segment is part of the contract rather than derived, because the path is
 * what a reviewing UI anchors on: `root.1.columns.0.blocks.2` has to keep
 * meaning the same block across releases, and only the consumer knows how its
 * own containers are addressed.
 */
export interface BlockGroup<B> {
  path: string;
  blocks: B[];
}

export interface BlockChange<L = unknown> {
  id: string;
  action: 'added' | 'removed' | 'modified' | 'moved';
  type: string;
  /** e.g. `root.0`, or `root.1.columns.0.blocks.2`. */
  path: string;
  attributes?: Record<string, { from: unknown; to: unknown }>;
  /** Whatever `leafDiff` returned. Absent when no `leafDiff` was supplied. */
  leafDiff?: L;
}

export interface RevisionDiff<L = unknown> {
  version: SemVer;
  changeType: ChangeType;
  changes: BlockChange<L>[];
  titleChanged: boolean;
  /** A page-level flag outside the block tree — a banner, a notice, a status. */
  metaChanged: boolean;
  summary: string;
}

export interface DiffOptions<B, L> {
  /** Nested groups in document order, or `null` for a leaf. */
  containers: (block: B) => BlockGroup<B>[] | null;
  /**
   * A richer diff for one leaf, when the consumer has one to give. `from` is
   * null for an addition, `to` is null for a removal. Return `undefined` to
   * record nothing, which is the right answer for most block types.
   */
  leafDiff?: (from: B | null, to: B | null) => L | undefined;
}

interface Located<B> {
  block: B;
  path: string;
}

/** Every block in the tree, flattened, each with the path that addresses it. */
export function extractBlocks<B>(
  blocks: readonly B[],
  containers: (block: B) => BlockGroup<B>[] | null,
  basePath = 'root',
): Located<B>[] {
  const out: Located<B>[] = [];
  blocks.forEach((block, i) => {
    const path = `${basePath}.${i}`;
    out.push({ block, path });
    for (const group of containers(block) ?? []) {
      out.push(...extractBlocks(group.blocks, containers, `${path}.${group.path}`));
    }
  });
  return out;
}

/**
 * Which scalar fields differ. Nested block arrays are skipped: they are walked
 * as their own entries, and comparing them here would report a container as
 * modified every time anything inside it moved.
 */
export function diffAttributes<B extends DiffBlock>(
  oldBlock: B,
  newBlock: B,
  nestedKeys: readonly string[],
): Record<string, { from: unknown; to: unknown }> | undefined {
  const diffs: Record<string, { from: unknown; to: unknown }> = {};
  const skip = new Set<string>(['id', 'type', ...nestedKeys]);
  for (const key of new Set([...Object.keys(oldBlock), ...Object.keys(newBlock)])) {
    if (skip.has(key)) continue;
    const from = (oldBlock as unknown as Record<string, unknown>)[key];
    const to = (newBlock as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) diffs[key] = { from, to };
  }
  return Object.keys(diffs).length > 0 ? diffs : undefined;
}

/**
 * Blocks matched by id, so a block that moved is reported as moved rather than
 * as one removal and one addition.
 */
export function diffBlocks<B extends DiffBlock, L = unknown>(
  oldBlocks: readonly B[],
  newBlocks: readonly B[],
  opts: DiffOptions<B, L>,
): BlockChange<L>[] {
  const nestedKeys = nestedKeysOf(oldBlocks, newBlocks, opts.containers);
  const changes: BlockChange<L>[] = [];
  const oldFlat = extractBlocks(oldBlocks, opts.containers);
  const newFlat = extractBlocks(newBlocks, opts.containers);

  const matchedOld = new Set<string>();
  const matchedNew = new Set<string>();
  const oldById = new Map(oldFlat.map(item => [item.block.id, item]));
  const newById = new Map(newFlat.map(item => [item.block.id, item]));

  for (const [id, oldItem] of oldById) {
    const newItem = newById.get(id);
    if (!newItem) continue;
    matchedOld.add(oldItem.path);
    matchedNew.add(newItem.path);

    if (oldItem.path !== newItem.path) {
      changes.push({
        id,
        action: 'moved',
        type: oldItem.block.type,
        path: newItem.path,
        attributes: { position: { from: oldItem.path, to: newItem.path } },
      });
    }

    const attributes = diffAttributes(oldItem.block, newItem.block, nestedKeys);
    if (attributes) {
      changes.push({
        id,
        action: 'modified',
        type: newItem.block.type,
        path: newItem.path,
        attributes,
        leafDiff: opts.leafDiff?.(oldItem.block, newItem.block),
      });
    }
  }

  for (const item of oldFlat) {
    if (matchedOld.has(item.path) || newById.has(item.block.id)) continue;
    changes.push({
      id: item.block.id,
      action: 'removed',
      type: item.block.type,
      path: item.path,
      leafDiff: opts.leafDiff?.(item.block, null),
    });
  }

  for (const item of newFlat) {
    if (matchedNew.has(item.path) || oldById.has(item.block.id)) continue;
    changes.push({
      id: item.block.id,
      action: 'added',
      type: item.block.type,
      path: item.path,
      leafDiff: opts.leafDiff?.(null, item.block),
    });
  }

  return changes;
}

/** The keys a container holds its children under, so they are not diffed twice. */
function nestedKeysOf<B>(
  oldBlocks: readonly B[],
  newBlocks: readonly B[],
  containers: (block: B) => BlockGroup<B>[] | null,
): string[] {
  const keys = new Set<string>();
  for (const block of [...oldBlocks, ...newBlocks]) {
    for (const group of containers(block) ?? []) {
      const head = group.path.split('.')[0];
      if (head) keys.add(head);
    }
  }
  return [...keys];
}

/**
 * `major` for structure, `minor` for prose, `patch` for a page-level flag.
 *
 * A `modified` change is only ever recorded when `diffAttributes` returned
 * something, so a non-empty change set is always at least a minor bump.
 */
export function classifyChanges(
  changes: readonly BlockChange<unknown>[],
  titleChanged: boolean,
  metaChanged = false,
): ChangeType {
  if (changes.length === 0 && !titleChanged && !metaChanged) return 'none';
  if (changes.some(c => c.action === 'added' || c.action === 'removed' || c.action === 'moved')) {
    return 'major';
  }
  if (changes.length > 0 || titleChanged) return 'minor';
  return 'patch';
}

export function changeSummary(diff: {
  changes: readonly BlockChange<unknown>[];
  titleChanged: boolean;
  metaChanged?: boolean;
  metaLabel?: string;
}): string {
  const parts: string[] = [];
  if (diff.titleChanged) parts.push('title updated');
  if (diff.metaChanged) parts.push(`${diff.metaLabel ?? 'banner'} updated`);
  const count = (action: BlockChange['action']) => diff.changes.filter(c => c.action === action).length;
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
  for (const [action, verb] of [
    ['added', 'added'],
    ['removed', 'removed'],
    ['modified', 'modified'],
    ['moved', 'reordered'],
  ] as const) {
    const n = count(action);
    if (n) parts.push(`${plural(n, 'block')} ${verb}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}

export function computeRevisionDiff<B extends DiffBlock, L = unknown>(opts: {
  currentVersion: string | null | undefined;
  oldContent: readonly B[];
  newContent: readonly B[];
  oldTitle: string;
  newTitle: string;
  /** A page-level value outside the block tree; compared by strict equality. */
  oldMeta?: unknown;
  newMeta?: unknown;
  /** What to call that value in the summary. Defaults to `banner`. */
  metaLabel?: string;
  containers: DiffOptions<B, L>['containers'];
  leafDiff?: DiffOptions<B, L>['leafDiff'];
}): RevisionDiff<L> {
  const changes = diffBlocks<B, L>(opts.oldContent, opts.newContent, {
    containers: opts.containers,
    leafDiff: opts.leafDiff,
  });
  const titleChanged = opts.oldTitle !== opts.newTitle;
  const metaChanged = opts.oldMeta !== opts.newMeta;
  const changeType = classifyChanges(changes, titleChanged, metaChanged);
  const partial = {
    version: incrementVersion(parseVersion(opts.currentVersion), changeType),
    changeType,
    changes,
    titleChanged,
    metaChanged,
  };
  return { ...partial, summary: changeSummary({ ...partial, metaLabel: opts.metaLabel }) };
}
