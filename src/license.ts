// license.ts — the licence declaration every agent surface has to carry.
//
// S10 requires a licence on every export — llms.txt, the agent card, the
// OpenAPI info block, the JSON-LD, the feed's `<copyright>` — and each repo
// satisfied that requirement by writing the same block again. The shape was
// identical in all three, and the sentence beginning "You may ingest, embed,
// and redistribute" was verbatim in all three.
//
// What is genuinely per-project is the scope: which half of a site the grant
// covers, and what it deliberately excludes. That is the `scope` and `excludes`
// below, and it is the only part a consumer should be writing by hand.

export interface License {
  /** SPDX identifier, e.g. `CC-BY-4.0`. */
  spdx: string;
  /** Human name, e.g. `Creative Commons Attribution 4.0 International`. */
  name: string;
  url: string;
  /** The credit line a dataset should carry. */
  attribution: string;
}

/** The grant every one of these wikis makes, parameterised by who is making it. */
export function ccBy40(opts: { siteName: string; siteUrl: string }): License {
  return {
    spdx: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: `Source: ${opts.siteName} (${opts.siteUrl}), CC BY 4.0`,
  };
}

export interface LicenseBlockOptions {
  license: License;
  /**
   * What the grant covers, as a sentence fragment completing "… is licensed
   * under". Defaults to naming the whole site, which is the rarer case: every
   * consumer of this so far grants over some of what it serves and not all.
   */
  scope?: string;
  /** Sentences appended after the identifiers — carve-outs, caveats, terms. */
  excludes?: readonly string[];
  /** `Licence` where the site's prose says so. Defaults to `License`. */
  heading?: string;
}

/**
 * The block, as lines, ready to join into any text export.
 *
 * Returned as an array rather than a string because every caller splices it
 * into a document it is already building line by line, and a caller that wants
 * the string can join it.
 */
export function licenseLines({
  license,
  scope = 'This content',
  excludes = [],
  heading = 'License & Attribution',
}: LicenseBlockOptions): string[] {
  return [
    `## ${heading}`,
    '',
    `${scope} is licensed under the ${license.name} (${license.spdx}): ${license.url}`,
    '',
    'You may ingest, embed, and redistribute this content in RAG systems, fine-tuning',
    'datasets, or other derivative works, including commercially. Attribution at the',
    'dataset or system level is sufficient.',
    '',
    `- Recommended attribution: "${license.attribution}"`,
    `- SPDX identifier: ${license.spdx}`,
    ...(excludes.length ? ['', ...excludes] : []),
  ];
}

export function licenseBlock(opts: LicenseBlockOptions): string {
  return licenseLines(opts).join('\n');
}

/** The one-line form, for a frontmatter field or a feed's `<copyright>`. */
export function licenseNote(license: License): string {
  return `${license.name} (${license.spdx}): ${license.url}`;
}
