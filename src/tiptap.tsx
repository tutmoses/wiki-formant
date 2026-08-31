'use client';

// tiptap.tsx — the custom editor nodes both wikis had written twice.
//
// Behind its own subpath for the same reason `react.tsx` is: the four
// `@tiptap/*` packages are OPTIONAL peer dependencies, so a consumer that only
// wants the taxonomy or the MCP transport still installs a package with no
// runtime dependencies at all.
//
// The two copies had drifted in both directions — one had grown tabs the other
// lacked, the other had extracted the Twitter helper the first still wrote out
// three times — which is the shape of drift that costs the most: neither copy
// is behind, so neither looks like the one to fix.
//
// What is shared is the node schema and its behaviour, never appearance. Class
// names and icons are injected, which is what lets one wiki keep `text-jupiter`
// and the other `text-accent` without either forking the node. It also keeps
// this file from dragging an icon library in behind it.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Node as TiptapNode, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import TiptapYoutube from '@tiptap/extension-youtube';
import TiptapCodeBlock from '@tiptap/extension-code-block';
import { onTweetResize, tweetEmbedSrc } from './dom.js';
import { toMapEmbedUrl } from './maps.js';
import { useClickOutside } from './react.js';

/** Local `cn`. Both wikis import one; the package will not depend on one. */
const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

// ---- iframe -----------------------------------------------------------------

export const Iframe = TiptapNode.create({
  name: 'iframe',
  group: 'block',
  atom: true,
  addAttributes() {
    return { src: { default: null }, width: { default: '100%' }, height: { default: '400' } };
  },
  parseHTML() {
    return [{ tag: 'iframe' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { 'data-iframe-embed': '', class: 'iframe-embed' },
      ['iframe', mergeAttributes(HTMLAttributes, { frameborder: '0', allowfullscreen: 'true' })],
    ];
  },
});

// ---- youtube ----------------------------------------------------------------

/** The stock extension plus the paste rule it does not ship with. */
export const YouTube = TiptapYoutube.extend({
  addPasteRules() {
    return [
      {
        find: /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)[^\s]*/g,
        handler: ({ match, chain, range }) => {
          if (match[0]) chain().deleteRange(range).setYoutubeVideo({ src: match[0] }).run();
        },
      },
    ];
  },
});

// ---- twitter ----------------------------------------------------------------

function TwitterEmbedView({ node }: { node: any }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The embed posts its measured height back; `onTweetResize` owns the origin
  // check, which is the part that was written out at four call sites.
  useEffect(
    () =>
      onTweetResize(height => {
        const iframe = containerRef.current?.querySelector('iframe');
        if (iframe) iframe.style.height = `${height}px`;
      }),
    [],
  );
  return (
    <NodeViewWrapper>
      <div ref={containerRef} className="twitter-embed">
        <iframe src={tweetEmbedSrc(node.attrs.tweetId)} scrolling="no" allowFullScreen />
      </div>
    </NodeViewWrapper>
  );
}

export const TwitterEmbed = TiptapNode.create({
  name: 'twitterEmbed',
  group: 'block',
  atom: true,
  addAttributes() {
    return { tweetId: { default: null }, url: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-twitter-embed]',
        getAttrs: el => ({
          tweetId: (el as HTMLElement).dataset.tweetId,
          url: (el as HTMLElement).dataset.url,
        }),
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'div',
      {
        'data-twitter-embed': '',
        'data-tweet-id': node.attrs.tweetId,
        'data-url': node.attrs.url,
        class: 'twitter-embed',
      },
      [
        'iframe',
        {
          src: tweetEmbedSrc(node.attrs.tweetId),
          frameborder: '0',
          allowfullscreen: 'true',
          scrolling: 'no',
        },
      ],
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TwitterEmbedView);
  },
  addPasteRules() {
    return [
      {
        find: /https?:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/g,
        handler: ({ match, chain, range }) => {
          const tweetId = match[1];
          if (tweetId)
            chain()
              .deleteRange(range)
              .insertContent({ type: 'twitterEmbed', attrs: { tweetId, url: match[0] } })
              .run();
        },
      },
    ];
  },
});

// ---- map --------------------------------------------------------------------

export interface MapEmbedOptions {
  /**
   * Follow a shortened map URL to one that can be embedded, or null.
   *
   * Injected because it needs the consumer's own API route: a `maps.app.goo.gl`
   * link cannot be resolved in the browser, so each app proxies the redirect.
   * The synchronous half of the parsing is `wiki-formant/maps`, used directly.
   */
  resolveMapUrl: (url: string) => Promise<string | null>;
}

/**
 * Google and Apple map links, pasted.
 *
 * A shortened link inserts immediately with `about:blank` and swaps its `src`
 * once the redirect resolves — pasting must not block on a network hop, and the
 * node has to already exist for the reader to see anything happen.
 */
export function createMapEmbed({ resolveMapUrl }: MapEmbedOptions) {
  return TiptapNode.create({
    name: 'mapEmbed',
    group: 'block',
    atom: true,
    addAttributes() {
      return { src: { default: null }, url: { default: null } };
    },
    parseHTML() {
      return [
        {
          tag: 'div[data-map-embed]',
          getAttrs: el => ({
            src: (el as HTMLElement).querySelector('iframe')?.getAttribute('src'),
            url: (el as HTMLElement).dataset.url,
          }),
        },
      ];
    },
    renderHTML({ node }) {
      return [
        'div',
        { 'data-map-embed': '', 'data-url': node.attrs.url || '', class: 'map-embed' },
        [
          'iframe',
          {
            src: node.attrs.src,
            frameborder: '0',
            allowfullscreen: 'true',
            loading: 'lazy',
            referrerpolicy: 'no-referrer-when-downgrade',
          },
        ],
      ];
    },
    addPasteRules() {
      const ext = this;
      const handler = ({ match, chain, range }: any) => {
        const url = match[0];
        const src = toMapEmbedUrl(url);
        if (src) {
          chain().deleteRange(range).insertContent({ type: 'mapEmbed', attrs: { src, url } }).run();
          return;
        }
        if (/maps\.app\.goo\.gl|goo\.gl\/maps/.test(url)) {
          chain()
            .deleteRange(range)
            .insertContent({ type: 'mapEmbed', attrs: { src: 'about:blank', url } })
            .run();
          resolveMapUrl(url).then(resolved => {
            if (!resolved) return;
            // Find the placeholder by its url rather than by a captured
            // position: the document has been editable throughout the hop.
            const { doc } = ext.editor.state;
            doc.descendants((node, pos) => {
              if (
                node.type.name === 'mapEmbed' &&
                node.attrs.url === url &&
                node.attrs.src === 'about:blank'
              ) {
                ext.editor
                  .chain()
                  .setNodeSelection(pos)
                  .updateAttributes('mapEmbed', { src: resolved })
                  .run();
                return false;
              }
              return undefined;
            });
          });
        }
      };
      return [
        { find: /https?:\/\/(?:www\.)?google\.[a-z.]+\/maps[^\s]*/g, handler },
        { find: /https?:\/\/maps\.app\.goo\.gl\/[^\s]+/g, handler },
        { find: /https?:\/\/goo\.gl\/maps\/[^\s]+/g, handler },
        { find: /https?:\/\/maps\.apple\.com[^\s]*/g, handler },
        { find: /https?:\/\/embed\.apple\.com\/maps[^\s]*/g, handler },
      ];
    },
  });
}

// ---- code block -------------------------------------------------------------

export interface CodeBlockClassNames {
  wrapper?: string;
  /** The control cluster, positioned over the block. */
  control?: string;
  button?: string;
  dropdown?: string;
  option?: string;
  /** Applied alongside `option` on the selected language. */
  optionActive?: string;
}

export interface CodeBlockOptions {
  /** Selectable languages. Each wiki's own list, from its block-utils. */
  langs: readonly string[];
  defaultLang: string;
  classNames?: CodeBlockClassNames;
  icons?: {
    lang?: ReactNode;
    /** Receives whether the dropdown is open, as `TableOfContents`'s icon does. */
    chevron?: (open: boolean) => ReactNode;
    selected?: ReactNode;
  };
}

/** A code block whose language is pickable from a dropdown. */
export function createCodeBlock({
  langs,
  defaultLang,
  classNames = {},
  icons = {},
}: CodeBlockOptions) {
  function CodeBlockView({
    node,
    updateAttributes,
  }: {
    node: any;
    updateAttributes: (attrs: Record<string, any>) => void;
  }) {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const dropdownRef = useClickOutside<HTMLDivElement>(close);
    const lang = node.attrs.language || defaultLang;

    return (
      <NodeViewWrapper className={classNames.wrapper}>
        <div ref={dropdownRef} className={classNames.control}>
          <button type="button" onClick={() => setOpen(!open)} className={classNames.button}>
            {icons.lang}
            <span>{lang}</span>
            {icons.chevron?.(open)}
          </button>
          {open && (
            <div className={classNames.dropdown}>
              {langs.map(l => (
                <button
                  type="button"
                  key={l}
                  onClick={() => {
                    updateAttributes({ language: l });
                    setOpen(false);
                  }}
                  className={cx(classNames.option, l === lang && classNames.optionActive)}
                >
                  {l}
                  {l === lang && icons.selected}
                </button>
              ))}
            </div>
          )}
        </div>
        <pre>
          <NodeViewContent as="code" className={`language-${lang}`} />
        </pre>
      </NodeViewWrapper>
    );
  }

  return TiptapCodeBlock.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        language: {
          default: defaultLang,
          parseHTML: el => el.querySelector('code')?.className?.match(/language-(\w+)/)?.[1] || defaultLang,
        },
      };
    },
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView);
    },
  });
}

// ---- tabs -------------------------------------------------------------------

export interface TabsClassNames {
  editor?: string;
  list?: string;
  tab?: string;
  /** Applied alongside `tab` on the open tab. */
  tabActive?: string;
  title?: string;
  remove?: string;
  add?: string;
  content?: string;
}

export interface TabsOptions {
  classNames?: TabsClassNames;
  icons?: { add?: ReactNode; remove?: ReactNode };
  /** Names a newly added tab. Receives the 1-based position. */
  tabLabel?: (index: number) => string;
}

/**
 * A tab group and its items, which must be registered together — `tabGroup`'s
 * content expression is `tabItem+`, so registering one without the other leaves
 * a node type the schema cannot satisfy.
 */
export function createTabs({
  classNames = {},
  icons = {},
  tabLabel = i => `Tab ${i}`,
}: TabsOptions = {}) {
  function TabGroupView({
    node,
    getPos,
    editor,
    updateAttributes,
  }: {
    node: any;
    getPos: () => number;
    editor: Editor;
    updateAttributes: (attrs: Record<string, any>) => void;
  }) {
    const activeTab = node.attrs.activeTab ?? 0;
    const tabs = node.content.content || [];
    const setActiveTab = (i: number) => updateAttributes({ activeTab: i });

    // Positions are walked from the group's own start rather than cached: every
    // edit inside a tab shifts every position after it.
    const posOf = (index: number) => {
      let pos = getPos() + 1;
      for (let i = 0; i < index; i++) pos += tabs[i].nodeSize;
      return pos;
    };

    const addTab = () =>
      editor
        .chain()
        .focus()
        .insertContentAt(getPos() + node.nodeSize - 1, {
          type: 'tabItem',
          attrs: { title: tabLabel(tabs.length + 1) },
          content: [{ type: 'paragraph' }],
        })
        .run();

    const removeTab = (index: number) => {
      // `tabItem+` means the last tab cannot be removed.
      if (tabs.length <= 1) return;
      const pos = posOf(index);
      editor.chain().focus().deleteRange({ from: pos, to: pos + tabs[index].nodeSize }).run();
      if (activeTab >= tabs.length - 1) setActiveTab(Math.max(0, tabs.length - 2));
    };

    const renameTab = (index: number, title: string) => {
      const { tr } = editor.state;
      tr.setNodeMarkup(posOf(index), undefined, { title });
      editor.view.dispatch(tr);
    };

    return (
      <NodeViewWrapper data-tabs="" data-active-tab={activeTab}>
        <div className={classNames.editor}>
          <div className={classNames.list}>
            {tabs.map((tab: any, i: number) => (
              <div key={i} className={cx(classNames.tab, activeTab === i && classNames.tabActive)}>
                <input
                  type="text"
                  value={tab.attrs.title}
                  onChange={e => renameTab(i, e.target.value)}
                  onClick={() => setActiveTab(i)}
                  className={classNames.title}
                />
                {tabs.length > 1 && (
                  <button type="button" onClick={() => removeTab(i)} className={classNames.remove}>
                    {icons.remove}
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={addTab} className={classNames.add}>
              {icons.add}
            </button>
          </div>
          <div className={classNames.content}>
            <NodeViewContent />
          </div>
        </div>
      </NodeViewWrapper>
    );
  }

  const TabGroup = TiptapNode.create({
    name: 'tabGroup',
    group: 'block',
    content: 'tabItem+',
    addAttributes() {
      return { activeTab: { default: 0 } };
    },
    parseHTML() {
      return [{ tag: 'div[data-tabs]' }];
    },
    renderHTML({ HTMLAttributes, node }) {
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          'data-tabs': '',
          'data-active-tab': node.attrs.activeTab,
        }),
        0,
      ];
    },
    addNodeView() {
      return ReactNodeViewRenderer(TabGroupView);
    },
  });

  const TabItem = TiptapNode.create({
    name: 'tabItem',
    group: 'tabItem',
    content: 'block+',
    defining: true,
    isolating: true,
    addAttributes() {
      return { title: { default: 'Tab' } };
    },
    parseHTML() {
      return [
        {
          tag: 'div[data-tab-item]',
          getAttrs: el => ({ title: (el as HTMLElement).getAttribute('data-tab-title') || 'Tab' }),
        },
      ];
    },
    renderHTML({ HTMLAttributes, node }) {
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          'data-tab-item': '',
          'data-tab-title': node.attrs.title,
        }),
        0,
      ];
    },
  });

  return { TabGroup, TabItem };
}
