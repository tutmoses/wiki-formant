// sanitize.ts — the allowlist between an author's saved HTML and every reader's
// browser.
//
// Every wiki here stores raw editor HTML and renders it through
// `dangerouslySetInnerHTML`, and `wiki-formant/block-views` renders three more
// such fields itself. Only one of the three had a sanitiser. Another gated
// writes on an $XRD balance, which is a price rather than a trust boundary, on
// a site whose readers connect wallets. The renderer that trusts those fields
// ships from here, so the guard does too.
//
// Everything is an allowlist: unknown tags, unknown attributes (every on*
// handler among them) and non-http(s) URLs are dropped, not escaped. Run it
// server-side, on the render path, so it covers rows written before it existed
// and no sanitiser ships to the client. `sanitize-html` is an optional peer.

import sanitizeHtml from 'sanitize-html';

// Inline SVG, presentational elements only. The infographics pipeline embeds
// diagrams as inline SVG in two of the wikis, so a prose-only list would erase
// them. `foreignObject` (arbitrary HTML), `use`/`image` (external refs),
// `script` and the animation elements are deliberately absent.
const SVG_TAGS = [
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'linearGradient',
  'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
];

// Inert geometry and paint values, applied to every SVG tag rather than per
// element: the tag list above is what bounds the surface.
const SVG_ATTRS = [
  'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'width', 'height', 'transform', 'viewBox', 'preserveAspectRatio', 'xmlns',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity',
  'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor',
  'dominant-baseline', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
  'gradientTransform', 'clip-path', 'mask', 'role', 'aria-label', 'style',
];

/**
 * The embed hosts the editor's iframe, YouTube, tweet and map nodes produce.
 * This is half of a pair: the CSP `frame-src` in each `next.config.ts` must
 * allow the same hosts, or an iframe survives sanitising and is then blocked.
 */
export const DEFAULT_IFRAME_HOSTS: readonly string[] = [
  'www.youtube.com', 'youtube.com',
  'www.youtube-nocookie.com', 'youtube-nocookie.com',
  'platform.twitter.com',
  'www.google.com', 'maps.google.com',
  'embed.apple.com', 'maps.apple.com',
];

// Layout and paint only. `position`, `z-index` and friends are left out so a
// page cannot lay a fake signing prompt over the site's chrome.
const STYLE_PROPS = [
  'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-radius', 'border-color', 'border-width', 'border-style',
  'background', 'background-color', 'color', 'opacity',
  'font-size', 'font-weight', 'font-style', 'line-height',
  'text-align', 'vertical-align', 'display', 'overflow',
];

// Ordinary CSS tokens plus rgb()/rgba(). Excluding quotes, backslashes, angle
// brackets and any other `(` keeps `url(...)` and `expression(...)` out of
// every property without a per-property regex.
const SAFE_CSS_VALUE = /^(?:[a-z0-9#%.,\-+/ ]|rgba?\([\d\s,.%]+\))*$/i;

const PROSE_TAGS = [
  'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code',
  'strong', 'em', 'b', 'i', 's', 'u', 'sub', 'sup', 'mark', 'small',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'iframe',
];

const PROSE_ATTRS: Record<string, string[]> = {
  a: ['href', 'target', 'rel', 'id', 'title', 'aria-label', 'tabindex'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
  // Every data attribute the `wiki-formant/tiptap` nodes store: the embed
  // wrappers, and the tab markup `activateTabGroups` reads back. An allowlist
  // written without the tab pair strips them, and stored tabs never activate.
  div: [
    'id', 'style',
    'data-twitter-embed', 'data-tweet-id', 'data-url', 'data-map-embed', 'data-iframe-embed', 'data-youtube-video',
    'data-tabs', 'data-active-tab', 'data-tab-item', 'data-tab-title',
  ],
  iframe: ['src', 'width', 'height', 'frameborder', 'allowfullscreen', 'scrolling', 'loading', 'referrerpolicy', 'title'],
  figure: ['style', 'data-graphic'],
  figcaption: ['style'],
  span: ['id', 'style', 'title'],
  p: ['id', 'style'],
  // `cite-n` back-link targets ride on the superscript.
  sup: ['id'],
  sub: ['id'],
  th: ['colspan', 'rowspan', 'colwidth', 'scope'],
  td: ['colspan', 'rowspan', 'colwidth'],
  col: ['span', 'width'],
  // Heading ids back the crawlable anchors `injectHeadingIds` writes.
  h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
  li: ['id'],
  blockquote: ['cite'],
};

/**
 * Classes are allowed by NAME, never by attribute. Restricting `style` to
 * layout and paint means nothing while `class` is free: every wiki here ships
 * utility classes like `fixed inset-0 z-50`, which lay a fake prompt over the
 * chrome as well as `position` would. These are the classes the package's own
 * editor nodes write; a wiki adds the ones its stored content uses.
 */
const EDITOR_CLASSES: Record<string, string[]> = {
  a: ['link'],
  code: ['language-*'],
  div: ['iframe-embed', 'map-embed', 'twitter-embed'],
  table: ['tiptap-table'],
  th: ['p-2', 'font-semibold', 'bg-surface-1'],
  td: ['p-2'],
};

export interface HtmlSanitizerOptions {
  /** Hosts an `<iframe src>` may point at. Defaults to `DEFAULT_IFRAME_HOSTS`. */
  iframeHosts?: readonly string[];
  /** Keep the presentational SVG subset. Defaults to true. */
  svg?: boolean;
  /** Tags this wiki's stored HTML needs beyond the prose set. */
  tags?: readonly string[];
  /** Attributes to add, per tag. Merged with the defaults, never replacing them. Not `class`: see `classes`. */
  attributes?: Readonly<Record<string, readonly string[]>>;
  /** Class names to allow, per tag (`'language-*'` globs work). Merged with the editor's own. */
  classes?: Readonly<Record<string, readonly string[]>>;
  /** URL schemes per tag, where one tag needs more than http/https/mailto — `img: ['http', 'https', 'data']`. */
  schemesByTag?: Readonly<Record<string, readonly string[]>>;
}

/**
 * A sanitiser bound to one wiki's allowlist.
 *
 * Derive `tags`, `attributes` and `classes` from the HTML actually stored in
 * your pages and revisions, not from guesswork: that is how the SVG set above
 * got here, and a list written from memory erases content on the first render.
 */
export function createHtmlSanitizer(options: HtmlSanitizerOptions = {}): (html: string) => string {
  const { iframeHosts = DEFAULT_IFRAME_HOSTS, svg = true, tags = [], attributes = {}, classes = {}, schemesByTag = {} } = options;

  const merge = (base: Record<string, string[]>, extra: Readonly<Record<string, readonly string[]>>) => {
    const out = { ...base };
    for (const [tag, more] of Object.entries(extra)) out[tag] = [...new Set([...(out[tag] ?? []), ...more])];
    return out;
  };
  const allowedAttributes = merge(
    svg ? { ...PROSE_ATTRS, ...Object.fromEntries(SVG_TAGS.map(t => [t, SVG_ATTRS])) } : PROSE_ATTRS,
    attributes,
  );
  // `class` only ever arrives through `allowedClasses`, which admits the
  // attribute for the tags it names and filters its value by name.
  for (const tag of Object.keys(allowedAttributes)) {
    allowedAttributes[tag] = allowedAttributes[tag]!.filter(a => a !== 'class');
  }

  const config: sanitizeHtml.IOptions = {
    allowedTags: [...PROSE_TAGS, ...(svg ? SVG_TAGS : []), ...tags],
    allowedAttributes,
    allowedClasses: merge(EDITOR_CLASSES, classes),
    allowedSchemesByTag: Object.fromEntries(Object.entries(schemesByTag).map(([t, v]) => [t, [...v]])),
    allowedStyles: { '*': Object.fromEntries(STYLE_PROPS.map(p => [p, [SAFE_CSS_VALUE]])) },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: false,
    allowedIframeHostnames: [...iframeHosts],
    // SVG names are camelCase (clipPath, viewBox). Lower-casing them would still
    // render, since the HTML parser re-adjusts known SVG names, but keeping the
    // case means what is stored is what was allowlisted.
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    // Drop the contents of a disallowed <script> or <style>, not just the tags.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
  };

  return (html: string): string => (!html || !html.includes('<') ? html : sanitizeHtml(html, config));
}

type Leaf = Record<string, unknown> & { type: string };

const each = (v: unknown, map: (item: Record<string, unknown>) => Record<string, unknown>): unknown =>
  Array.isArray(v) ? v.map(item => (item && typeof item === 'object' ? map(item as Record<string, unknown>) : item)) : v;

const str = (v: unknown): v is string => typeof v === 'string';

/**
 * The core leaf types' HTML fields, cleaned: `content.text`, `codeTabs` code,
 * `linkGrid` group descriptions and `references` item text. Every other field
 * those blocks carry renders as a React text node and is escaped already.
 *
 * Returns any other block untouched, so it drops straight into a
 * `mapBlockTree` pass — a repo whose own types render HTML cleans those itself.
 *
 * `codeTabs` code is treated as stored HTML, which is what the editor writes.
 * A wiki whose highlighter takes the code as SOURCE and escapes it on render
 * must not pass it through here — every `<T>` in a signature would go — and
 * cleans its other three fields with its own switch.
 */
export function sanitizeCoreLeaf<B extends { type: string }>(block: B, clean: (html: string) => string): B {
  const b = block as unknown as Leaf;
  switch (b.type) {
    case 'content':
      return str(b.text) ? ({ ...b, text: clean(b.text) } as unknown as B) : block;
    case 'codeTabs':
      return { ...b, tabs: each(b.tabs, t => (str(t.code) ? { ...t, code: clean(t.code) } : t)) } as unknown as B;
    case 'linkGrid':
      return {
        ...b,
        groups: each(b.groups, g => (str(g.description) ? { ...g, description: clean(g.description) } : g)),
      } as unknown as B;
    case 'references':
      return { ...b, items: each(b.items, i => (str(i.text) ? { ...i, text: clean(i.text) } : i)) } as unknown as B;
    default:
      return block;
  }
}
