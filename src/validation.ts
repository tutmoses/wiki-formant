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
export function validateReferenceItems(items: unknown, urlCheck: (u: unknown) => boolean = okUrl): boolean {
  return (
    Array.isArray(items) &&
    items.every(
      it =>
        isRecord(it) &&
        typeof it.id === 'string' &&
        typeof it.text === 'string' &&
        (it.url === undefined || urlCheck(it.url)),
    )
  );
}

/** `[{ id, heading, links: [{ label, href }] }]` — a link-grid block's groups. */
export function validateLinkGroups(groups: unknown, urlCheck: (u: unknown) => boolean = okUrl): boolean {
  return (
    Array.isArray(groups) &&
    groups.every(
      g =>
        isRecord(g) &&
        typeof g.id === 'string' &&
        typeof g.heading === 'string' &&
        Array.isArray(g.links) &&
        g.links.every(l => isRecord(l) && typeof l.label === 'string' && urlCheck(l.href)),
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

/**
 * The block-tree walk, with one wiki's leaf switch plugged into it. The caller
 * keeps its own type parameter, so this stays free of any repo's types while
 * the call site still gets a real type guard.
 */
export function createBlockValidator(opts: BlockValidatorOptions) {
  const { isKnownType, isAtomicType, validateAtomic } = opts;

  const atomic = (block: unknown): boolean => {
    if (!isRecord(block)) return false;
    if (typeof block.id !== 'string') return false;
    if (typeof block.type !== 'string' || !isKnownType(block.type) || !isAtomicType(block.type)) return false;
    return validateAtomic(block);
  };

  const one = (block: unknown): boolean => {
    if (!isRecord(block)) return false;
    if (typeof block.id !== 'string') return false;
    if (typeof block.type !== 'string' || !isKnownType(block.type)) return false;

    if (block.type === 'columns') {
      return (
        Array.isArray(block.columns) &&
        block.columns.every(
          col =>
            isRecord(col) &&
            typeof col.id === 'string' &&
            Array.isArray(col.blocks) &&
            col.blocks.every(atomic),
        )
      );
    }
    if (block.type === 'infobox') {
      return Array.isArray(block.blocks) && block.blocks.every(atomic);
    }
    return atomic(block);
  };

  return {
    /** One leaf block; container types are rejected. */
    validateAtomicBlock: atomic,
    /** One block of any kind, containers included. */
    validateBlock: one,
    /** A whole page's content array. */
    validateBlocks: (content: unknown): boolean => Array.isArray(content) && content.every(one),
  };
}

/**
 * A copy of a block with a fresh id at every level, so a duplicated container
 * does not share child ids with its original.
 */
export function duplicateBlockIds<B extends { type: string; id: string }>(block: B, newId: () => string): B {
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
