// validation.ts — the block-tree checks that are the same wiki to wiki.
//
// Both wikis validate a block tree before it reaches the database, and both had
// written the same walk: an id-and-type gate, a container branch for
// columns/infobox, and a switch over leaf types. Only the switch is a project's
// own — its type set is. So the walk and the two fiddly nested validators live
// here, and the switch is passed in.
//
// As elsewhere in this package, the dispatch stays with the caller so a new
// block type is a compile error there until it is handled.

/**
 * An href acceptable to persist: http, https, mailto, or a relative path or
 * fragment. Everything else — `javascript:`, `data:`, `vbscript:`, a
 * protocol-relative `//host` — comes back null.
 *
 * React 19 already neutralises `javascript:` in an href at render time, so this
 * is defence in depth rather than the only thing between an editor and a
 * reader. Its value is at the write path: a URL that can never render safely is
 * better rejected than stored.
 */
export function safeLinkHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip C0 controls (including tab, newline and CR) and DEL before reading
  // the scheme, so a newline cannot smuggle one past the match below.
  const href = raw.replace(/[\u0000-\u0020\u007f]/g, '').trim();
  if (!href) return null;
  if (href.startsWith('//')) return null; // protocol-relative -> external host
  const scheme = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme) {
    const s = scheme[1]!.toLowerCase();
    if (s !== 'http' && s !== 'https' && s !== 'mailto') return null;
  }
  return href;
}

/** An author-supplied URL is fine iff it is empty (unset) or resolves safely. */
export const okUrl = (u: unknown): boolean =>
  typeof u === 'string' && (u === '' || safeLinkHref(u) !== null);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** `[{ id, text, url? }]` — the shape a references block stores. */
export function validateReferenceItems(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.every(
      it =>
        isRecord(it) &&
        typeof it.id === 'string' &&
        typeof it.text === 'string' &&
        (it.url === undefined || okUrl(it.url)),
    )
  );
}

/** `[{ id, heading, links: [{ label, href }] }]` — a link-grid block's groups. */
export function validateLinkGroups(groups: unknown): boolean {
  return (
    Array.isArray(groups) &&
    groups.every(
      g =>
        isRecord(g) &&
        typeof g.id === 'string' &&
        typeof g.heading === 'string' &&
        Array.isArray(g.links) &&
        g.links.every(l => isRecord(l) && typeof l.label === 'string' && okUrl(l.href)),
    )
  );
}

/** `[{ label, language?, code }]` — a code-tabs block's tabs. `code` renders as HTML. */
export function validateCodeTabs(tabs: unknown): boolean {
  return (
    Array.isArray(tabs) &&
    tabs.every(
      t =>
        isRecord(t) &&
        typeof t.label === 'string' &&
        typeof t.code === 'string' &&
        (t.language === undefined || typeof t.language === 'string'),
    )
  );
}

/** `[{ value, label, suffix? }]` — a stats block's cards. */
export function validateStatItems(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.every(
      s =>
        isRecord(s) &&
        typeof s.label === 'string' &&
        (typeof s.value === 'string' || typeof s.value === 'number') &&
        (s.suffix === undefined || s.suffix === null || typeof s.suffix === 'string'),
    )
  );
}

export interface BlockValidatorOptions {
  /** True for a type this wiki knows at all. */
  isKnownType: (type: string) => boolean;
  /** True for a type that may nest inside a container. */
  isAtomicType: (type: string) => boolean;
  /** This wiki's switch over its leaf types. Runs only after id/type pass. */
  validateAtomic: (block: Record<string, unknown>) => boolean;
}

/** Where a block tree fails, and why: `{ path: '[2].columns[0].blocks[1]', reason }`. */
export interface BlockIssue {
  path: string;
  reason: string;
}

/**
 * The block-tree walk, with one wiki's leaf switch plugged into it. The caller
 * keeps its own type parameter, so this stays free of any repo's types while
 * the call site still gets a real type guard.
 *
 * `blockIssues` is the same walk reporting WHERE. Every write path here
 * answered a bad tree with "invalid block structure" and nothing else, which
 * leaves an agent writing through MCP to guess, and one repo's seed guard had
 * to walk the tree a second time just to name the offending link.
 */
export function createBlockValidator(opts: BlockValidatorOptions) {
  const { isKnownType, isAtomicType, validateAtomic } = opts;

  const check = (block: unknown, path: string, nested: boolean, out: BlockIssue[]): void => {
    if (!isRecord(block)) {
      out.push({ path, reason: 'not a block object' });
      return;
    }
    if (typeof block.id !== 'string') out.push({ path, reason: '`id` must be a string' });
    if (typeof block.type !== 'string' || !isKnownType(block.type)) {
      out.push({ path, reason: `unknown block type ${JSON.stringify(block.type)}` });
      return;
    }

    if (!nested && block.type === 'columns') {
      if (!Array.isArray(block.columns)) {
        out.push({ path: `${path}.columns`, reason: 'must be an array' });
        return;
      }
      block.columns.forEach((col, i) => {
        const at = `${path}.columns[${i}]`;
        if (!isRecord(col) || typeof col.id !== 'string' || !Array.isArray(col.blocks)) {
          out.push({ path: at, reason: 'a column needs a string `id` and a `blocks` array' });
          return;
        }
        col.blocks.forEach((b, j) => check(b, `${at}.blocks[${j}]`, true, out));
      });
      return;
    }
    if (!nested && block.type === 'infobox') {
      if (!Array.isArray(block.blocks)) {
        out.push({ path: `${path}.blocks`, reason: 'must be an array' });
        return;
      }
      block.blocks.forEach((b, j) => check(b, `${path}.blocks[${j}]`, true, out));
      return;
    }

    if (!isAtomicType(block.type)) {
      out.push({ path, reason: nested ? `a ${block.type} block cannot sit inside a container` : `${block.type} blocks are not accepted` });
      return;
    }
    if (!validateAtomic(block)) out.push({ path, reason: `malformed ${block.type} block` });
  };

  const issuesOf = (block: unknown, nested: boolean): BlockIssue[] => {
    const out: BlockIssue[] = [];
    check(block, '', nested, out);
    return out;
  };

  const blockIssues = (content: unknown): BlockIssue[] => {
    if (!Array.isArray(content)) return [{ path: '', reason: 'content must be an array of blocks' }];
    const out: BlockIssue[] = [];
    content.forEach((block, i) => check(block, `[${i}]`, false, out));
    return out;
  };

  return {
    /** One leaf block; container types are rejected. */
    validateAtomicBlock: (block: unknown): boolean => issuesOf(block, true).length === 0,
    /** One block of any kind, containers included. */
    validateBlock: (block: unknown): boolean => issuesOf(block, false).length === 0,
    /** A whole page's content array. */
    validateBlocks: (content: unknown): boolean => blockIssues(content).length === 0,
    /** Every failure in a page's content array, each with the path to it. */
    blockIssues,
  };
}

/** One line for an error response: the first few issues, then a count. */
export function describeBlockIssues(issues: readonly BlockIssue[], max = 3): string {
  const shown = issues.slice(0, max).map(i => (i.path ? `${i.path}: ${i.reason}` : i.reason));
  const more = issues.length - shown.length;
  return `${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * A copy of a block with a fresh id at every level, so a duplicated container
 * does not share child ids with its original.
 */
export function duplicateBlockIds<B extends { type: string; id: string }>(
  block: B,
  newId: () => string = () => crypto.randomUUID(),
): B {
  const b = block as unknown as Record<string, unknown>;
  if (block.type === 'columns' && Array.isArray(b.columns)) {
    return {
      ...block,
      id: newId(),
      columns: b.columns.map(col => {
        const c = col as Record<string, unknown>;
        return { ...c, id: newId(), blocks: ((c.blocks as unknown[]) ?? []).map(x => ({ ...(x as object), id: newId() })) };
      }),
    } as unknown as B;
  }
  if (block.type === 'infobox' && Array.isArray(b.blocks)) {
    return { ...block, id: newId(), blocks: b.blocks.map(x => ({ ...(x as object), id: newId() })) } as unknown as B;
  }
  return { ...block, id: newId() };
}
