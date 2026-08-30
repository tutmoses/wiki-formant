// blocks.ts — the parts of a block tree that are the same wiki to wiki.
//
// A wiki's block TYPE SET is its own and always will be: one has an on-chain
// timeline, another an asset-price widget. What is not its own is the shape of
// the markdown those blocks flatten to. Two wikis in this workspace had the
// same seven case bodies, character for character, and the same container walk
// underneath them — including the same `\n{3,}` collapse at the end.
//
// So the dispatch stays with the caller (a `switch` over its own union, where a
// new block type is a compile error until it is handled) and the bodies come
// from here. Each renderer takes the block's DATA rather than the block, which
// keeps this file free of any one repo's type union.

import { decodeEntities } from './entities.js';
import { htmlToMarkdown, inlineToMarkdown } from './markdown.js';

// ---- the shapes the standard block types carry ------------------------------

export interface CodeTab {
  label: string;
  language?: string;
  code: string;
}

export interface ReferenceItem {
  text: string;
  url?: string | null;
}

export interface StatItem {
  value: string | number;
  label: string;
  suffix?: string | null;
}

export interface LinkGridLink {
  label: string;
  href: string;
}

export interface LinkGridGroup {
  heading: string;
  description?: string | null;
  links: readonly LinkGridLink[];
}

// ---- the container walk -----------------------------------------------------

export interface BlockTreeOptions<B> {
  /** Render one leaf block. Return `''` to drop it from the document. */
  atomic: (block: B) => string;
  /**
   * The nested block groups a container holds, in document order, or `null`
   * for a leaf. An infobox is one group; a columns block is one per column.
   */
  containers?: (block: B) => B[][] | null;
  /**
   * What joins blocks *inside* a container. Defaults to a blank line, which is
   * what markdown needs between paragraphs. Plain-text extraction passes a
   * single newline: it is flattening for a reader, not typesetting.
   */
  groupSeparator?: string;
}

/**
 * The whole tree as markdown. Containers flatten in document order, because a
 * reader following prose does not have columns — and an agent quoting the page
 * needs the sentences adjacent, not interleaved.
 */
export function renderBlockTree<B>(blocks: readonly B[], opts: BlockTreeOptions<B>): string {
  const { atomic, containers, groupSeparator = '\n\n' } = opts;
  return blocks
    .map(block => {
      const groups = containers?.(block);
      if (!groups) return atomic(block);
      return groups
        .map(group => group.map(atomic).filter(Boolean).join(groupSeparator))
        .filter(Boolean)
        .join(groupSeparator);
    })
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- the shared leaf renderers ----------------------------------------------

/**
 * Fenced blocks, one per tab, each under its label.
 *
 * The editor stores highlighted code, so the tags come out before the fence
 * goes on — a fenced block full of `<span class="hljs-keyword">` is worse than
 * no code at all.
 */
export function codeTabsToMarkdown(tabs: readonly CodeTab[]): string {
  return tabs
    .map(
      t =>
        `**${t.label}**\n\n\`\`\`${t.language || ''}\n${decodeEntities(t.code.replace(/<[^>]+>/g, '')).trim()}\n\`\`\``,
    )
    .join('\n\n');
}

/** A maintenance notice as a blockquote. `label` is the caller's display string. */
export function bannerToMarkdown(label: string, text?: string | null): string {
  return `> **[${label}]**${text ? ` ${inlineToMarkdown(text)}` : ''}`;
}

/** A numbered citation list, or `''` when there is nothing to cite. */
export function referencesToMarkdown(
  items: readonly ReferenceItem[],
  title = 'References',
): string {
  if (!items.length) return '';
  const lines = items.map(
    (r, i) => `${i + 1}. ${inlineToMarkdown(r.text)}${r.url ? ` — ${r.url}` : ''}`,
  );
  return `### ${title}\n\n${lines.join('\n')}`;
}

/** Metric cards as a bullet list, or `''` when empty. */
export function statsToMarkdown(items: readonly StatItem[]): string {
  if (!items.length) return '';
  return items.map(s => `- **${s.value}${s.suffix ?? ''}** — ${s.label}`).join('\n');
}

/** Grouped links under their headings, with an optional lead paragraph. */
export function linkGridToMarkdown(
  groups: readonly LinkGridGroup[],
  intro?: string | null,
): string {
  const lead = intro ? `${inlineToMarkdown(intro)}\n\n` : '';
  const rendered = groups.map(g =>
    [
      `### ${g.heading}`,
      ...(g.description ? ['', htmlToMarkdown(g.description)] : []),
      '',
      ...g.links.map(l => `- [${l.label}](${l.href})`),
    ].join('\n'),
  );
  return `${lead}${rendered.join('\n\n')}`;
}

/** A flat bullet list of links — resolved page lists, feed items, link rails. */
export function linkList(items: readonly LinkGridLink[]): string {
  return items.map(l => `- [${l.label}](${l.href})`).join('\n');
}
