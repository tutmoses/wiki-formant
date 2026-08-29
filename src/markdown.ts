// markdown.ts — HTML → markdown for the `.md` twin of a content page.
//
// Distinct from a plain text extractor, which flattens everything to prose.
// This preserves the structure an agent navigates and cites by — headings,
// lists, tables, code, emphasis — so a fetched page can be quoted precisely
// instead of re-summarised.
//
// Block trees are NOT handled here: every project owns its own block type set,
// so `blocksToMarkdown` belongs in the app. Give this module HTML and it gives
// you markdown; give `frontmatter` the fields and it gives you the document
// head. That is the whole portable half.

import { decodeEntities } from './entities.js';

/** Inline-level HTML → markdown. Applied inside cells, list items, headings. */
export function inlineToMarkdown(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<(?:strong|b)\b[^>]*>(.*?)<\/(?:strong|b)>/gi, '**$1**')
      .replace(/<(?:em|i)\b[^>]*>(.*?)<\/(?:em|i)>/gi, '_$1_')
      .replace(/<code\b[^>]*>(.*?)<\/code>/gi, '`$1`')
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<img\b[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi, '![$1]($2)')
      .replace(/<img\b[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** One `<table>` → a GFM table. Falls back to nothing when there are no rows. */
export function tableToMarkdown(html: string): string {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m =>
    [...m[1]!.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(c =>
      inlineToMarkdown(c[2]!).replace(/\|/g, '\\|'),
    ),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map(r => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  // A table whose first row is all <th> has a header; otherwise synthesise an
  // empty one, since GFM has no headerless table form.
  const headed = /<th\b/i.test(html.slice(0, html.indexOf('</tr>') + 1));
  const [head, ...body] = headed
    ? [pad(rows[0]!), ...rows.slice(1).map(pad)]
    : [Array(width).fill(''), ...rows.map(pad)];
  return [
    `| ${head!.join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** Block-level HTML → markdown. */
export function htmlToMarkdown(html: string): string {
  let out = html;

  // Tables first — their inner markup must not be eaten by the generic rules.
  out = out.replace(
    /<table\b[^>]*>[\s\S]*?<\/table>/gi,
    m => `\n\n${tableToMarkdown(m)}\n\n`,
  );

  // Lists. `<ol>` numbering is computed per-list, which is why this cannot be a
  // single regex with a `$1` backreference — inside a replace callback `$1` is
  // a literal, not a substitution. (That exact bug shipped once and rendered
  // every ordered list as a column of `1. $1`.)
  out = out.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, body: string) => {
    const items = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(
      i => `- ${inlineToMarkdown(i[1]!)}`,
    );
    return `\n\n${items.join('\n')}\n\n`;
  });
  out = out.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, body: string) => {
    const items = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(
      (i, n) => `${n + 1}. ${inlineToMarkdown(i[1]!)}`,
    );
    return `\n\n${items.join('\n')}\n\n`;
  });

  out = out
    .replace(
      /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
      (_m, code: string) => `\n\n\`\`\`\n${decodeEntities(code).trim()}\n\`\`\`\n\n`,
    )
    .replace(
      /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
      (_m, code: string) => `\n\n\`\`\`\n${decodeEntities(code).trim()}\n\`\`\`\n\n`,
    )
    .replace(
      /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_m, body: string) =>
        `\n\n${inlineToMarkdown(body)
          .split('\n')
          .map(l => `> ${l}`)
          .join('\n')}\n\n`,
    )
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, level: string, body: string) =>
        `\n\n${'#'.repeat(Number(level))} ${inlineToMarkdown(body)}\n\n`,
    )
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, body: string) => `\n\n${inlineToMarkdown(body)}\n\n`)
    .replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, (_m, body: string) => `\n\n${inlineToMarkdown(body)}\n\n`);

  return decodeEntities(out.replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const isoDate = (d: Date | string): string =>
  (typeof d === 'string' ? d : d.toISOString()).split('T')[0]!;

export interface FrontmatterFields {
  title: string;
  url: string;
  updated?: Date | string | null;
  /** When the page's facts were last checked against sources — the freshness
   *  signal an agent actually needs, and the one most twins omit. */
  lastVerified?: Date | string | null;
  license?: { spdx: string; url: string } | null;
  /** Any additional scalar rows, emitted in insertion order. */
  extra?: Record<string, string | number | undefined>;
}

/** YAML frontmatter block, `---` fences included. */
export function frontmatter(fields: FrontmatterFields): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  return [
    '---',
    `title: "${esc(fields.title)}"`,
    `url: "${fields.url}"`,
    ...(fields.updated ? [`updated: ${isoDate(fields.updated)}`] : []),
    ...(fields.lastVerified ? [`last_verified: ${isoDate(fields.lastVerified)}`] : []),
    ...(fields.license
      ? [`license: ${fields.license.spdx}`, `license_url: "${fields.license.url}"`]
      : []),
    ...Object.entries(fields.extra ?? {})
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => (typeof v === 'number' ? `${k}: ${v}` : `${k}: "${esc(String(v))}"`)),
    '---',
  ].join('\n');
}

/** A complete markdown document: frontmatter, an H1, and a body you supply. */
export function markdownDocument(fields: FrontmatterFields, body: string): string {
  return `${frontmatter(fields)}\n\n# ${fields.title}\n\n${body.trim()}\n`;
}
