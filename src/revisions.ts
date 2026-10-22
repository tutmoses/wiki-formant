// revisions.ts — what changed between two versions of a page.
//
// The semver lives next door in `versioning.ts`; this is the walk that decides
// which bump to ask for, and carries a leaf-level diff for a history view.
// Matching is by id.

import { incrementVersion, parseVersion, type ChangeType, type SemVer } from './versioning.js';
import { coreBlockGroups } from './blocks.js';

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

export interface RevisionDiff {
  version: SemVer;
  changeType: ChangeType;
  changes: BlockChange[];
  titleChanged: boolean;
  summary: string;
}

export interface DiffOptions<B, L> {
  /**
   * Nested groups in document order, or `null` for a leaf. Defaults to
   * `coreBlockGroups` — `columns.i.blocks` and an infobox's `blocks` — which is
   * every container any wiki here stores.
   */
  containers?: (block: B) => BlockGroup<B>[] | null;
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

/**
 * A path as a reader says it: `root.1.columns.0.blocks.2` is
 * "Block 2 → Column 1 → Block 3". Positions count from one; a segment that
 * names a group (`blocks`, `columns`) only says what the next number counts.
 */
export function blockLocation(path: string): string {
  let group = '';
  const out: string[] = [];
  for (const seg of path.split('.').slice(1)) {
    if (/^\d+$/.test(seg)) out.push(`${group === 'columns' ? 'Column' : 'Block'} ${Number(seg) + 1}`);
    else group = seg;
  }
  return out.join(' → ');
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

/** A value with every object's keys in one order: jsonb hands a stored block's keys back in its own. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

/**
 * Which scalar fields differ, whatever order their keys are in. Nested block arrays are skipped: they are walked
 * as their own entries, and comparing them here would report a container as
 * modified every time anything inside it moved.
 */
function diffAttributes<B extends DiffBlock>(
  oldBlock: B,
  newBlock: B,
  containers: (block: B) => BlockGroup<B>[] | null,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const diffs: Record<string, { from: unknown; to: unknown }> = {};
  // Derived from these two blocks rather than from the tree, so a container
  // nested inside another container is still exempted. Deriving it once from
  // the top level would miss a columns block that only ever appears inside an
  // infobox, and report it as edited whenever anything under it moved.
  const skip = new Set<string>(['id', 'type']);
  for (const block of [oldBlock, newBlock]) {
    for (const group of containers(block) ?? []) {
      const head = group.path.split('.')[0];
      if (head) skip.add(head);
    }
  }
  for (const key of new Set([...Object.keys(oldBlock), ...Object.keys(newBlock)])) {
    if (skip.has(key)) continue;
    const from = (oldBlock as unknown as Record<string, unknown>)[key];
    const to = (newBlock as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(canonical(from)) !== JSON.stringify(canonical(to))) diffs[key] = { from, to };
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
  const changes: BlockChange<L>[] = [];
  const containers = opts.containers ?? coreBlockGroups;
  const oldFlat = extractBlocks(oldBlocks, containers);
  const newFlat = extractBlocks(newBlocks, containers);

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

    const attributes = diffAttributes(oldItem.block, newItem.block, containers);
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

/**
 * `major` for structure, `minor` for prose and the title.
 *
 * A `modified` change is only ever recorded when `diffAttributes` returned
 * something, so a non-empty change set is always at least a minor bump.
 *
 * @internal
 */
export function classifyChanges(changes: readonly BlockChange<unknown>[], titleChanged: boolean): ChangeType {
  if (changes.some(c => c.action === 'added' || c.action === 'removed' || c.action === 'moved')) {
    return 'major';
  }
  return changes.length > 0 || titleChanged ? 'minor' : 'none';
}

export function changeSummary(diff: { changes: readonly BlockChange<unknown>[]; titleChanged: boolean }): string {
  const parts: string[] = [];
  if (diff.titleChanged) parts.push('title updated');
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

export function computeRevisionDiff<B extends DiffBlock>(opts: {
  currentVersion: string | null | undefined;
  oldContent: readonly B[];
  newContent: readonly B[];
  oldTitle: string;
  newTitle: string;
  containers?: DiffOptions<B, unknown>['containers'];
}): RevisionDiff {
  const changes = diffBlocks<B>(opts.oldContent, opts.newContent, { containers: opts.containers });
  const titleChanged = opts.oldTitle !== opts.newTitle;
  const changeType = classifyChanges(changes, titleChanged);
  const partial = {
    version: incrementVersion(parseVersion(opts.currentVersion), changeType),
    changeType,
    changes,
    titleChanged,
  };
  return { ...partial, summary: changeSummary(partial) };
}
