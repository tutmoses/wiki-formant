'use client';

// editor.tsx — the wiki rich-text editor's engine, minus its chrome.
//
// `tiptap.tsx` holds the custom NODES both wikis needed (iframe, tweet, map,
// code block, tabs). This holds what sits around them: which extensions are
// configured how, what a paste is scrubbed down to, how a pasted URL becomes
// the right embed, and the state a toolbar reads.
//
// TWO GUARDS HERE ARE LOAD-BEARING:
//
//   1. `onChangeRef.current = onChange` is written in an effect, never during
//      render: a ref mutated mid-render can tear under concurrent rendering.
//      It is only read from events and timeouts, which run later.
//   2. Blur flushes the pending debounce. The change is debounced 150ms, and
//      clicking Save blurs the editor before the click lands, so without the
//      flush the final keystroke of an edit that ends in a click is dropped.
//      It flushes only an edit still pending: Tiptap rewrites stored HTML into
//      its own form, so reporting every blur told a page that had only been
//      clicked through it had unsaved changes.
//
// Every @tiptap package here is an OPTIONAL PEER. A consumer that only wants
// the taxonomy or the MCP transport installs none of them.

import StarterKit from '@tiptap/starter-kit';
import TiptapLink from '@tiptap/extension-link';
import TiptapImage from '@tiptap/extension-image';
import TiptapTable from '@tiptap/extension-table';
import TiptapTableRow from '@tiptap/extension-table-row';
import TiptapTableCell from '@tiptap/extension-table-cell';
import TiptapTableHeader from '@tiptap/extension-table-header';
import Placeholder from '@tiptap/extension-placeholder';
import { useEditor } from '@tiptap/react';
import { Editor as TiptapEditor, Node as TiptapNode, type AnyExtension, type Editor } from '@tiptap/core';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { toMapEmbedUrl } from './maps.js';
import { cx } from './html.js';

/**
 * Re-exported so the COMMAND AUGMENTATIONS reach consumers.
 *
 * Each of these packages ships a `declare module '@tiptap/core'` block that adds
 * its commands to `ChainedCommands` — `toggleBold`, `insertTable`, `setLink`,
 * `setImage`. Because this module owns the extensions, it has to carry
 * the augmentation across the package boundary, and a re-exported type is what
 * makes the emitted `.d.ts` load the module that declares it. Without these
 * four lines every `editor.chain().focus().toggleBold()` in every consumer
 * stops type-checking.
 */
export type { StarterKitOptions } from '@tiptap/starter-kit';
export type { LinkOptions } from '@tiptap/extension-link';
export type { ImageOptions } from '@tiptap/extension-image';
export type { TableOptions } from '@tiptap/extension-table';

/** The view and the editor's type, so a consumer imports nothing from `@tiptap/*` itself. */
export { EditorContent } from '@tiptap/react';
export type { Editor } from '@tiptap/core';

// ---- paste scrubbing --------------------------------------------------------

/**
 * Reduce pasted HTML to structure plus the three attributes that carry meaning.
 *
 * A paste from a word processor or a web page arrives carrying its whole
 * stylesheet inline. Keeping any of it means the wiki's own typography loses to
 * whatever the author copied from, per paragraph, invisibly — and `style` on a
 * pasted node is also the cheapest way to smuggle a full-bleed overlay into a
 * page body.
 *
 * Browser-only: it parses with `DOMParser`. Called from `transformPastedHTML`,
 * which only ever runs in response to a paste.
 */
function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, script, meta, link, svg, canvas, noscript').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    el.removeAttribute('style');
    el.removeAttribute('class');
    el.removeAttribute('id');
    Array.from(el.attributes).forEach(attr => {
      if (!['href', 'src', 'alt'].includes(attr.name)) el.removeAttribute(attr.name);
    });
  });
  return doc.body.innerHTML;
}

// ---- extensions -------------------------------------------------------------

/**
 * Tiptap's Link, storing an href and the `link` class and nothing else.
 *
 * Stock Link writes `target="_blank" rel="noopener noreferrer nofollow"` onto
 * every link, internal ones included, and the schema then reads both back from
 * stored HTML, so a page edited once kept them for good. Nofollow on a site's
 * own links throws away its link equity, and a new tab for in-site navigation
 * is a bug. Whether a link is external depends on the host it is served from,
 * which the editor cannot know, so the render path decides: `normaliseLinks`
 * from `wiki-formant/links`. Dropping both attributes from the mark also cleans
 * a legacy link the next time its page is saved.
 *
 * @internal
 */
export const wikiLink = TiptapLink.extend({
  addAttributes() {
    return Object.fromEntries(
      Object.entries(this.parent?.() ?? {}).filter(([name]) => name !== 'target' && name !== 'rel'),
    );
  },
}).configure({ openOnClick: false, HTMLAttributes: { class: 'link', target: null, rel: null } });

export interface WikiEditorExtensionOptions {
  /** Empty-document prompt. */
  placeholder?: string;
  /**
   * The custom nodes, built by the consumer.
   *
   * They stay the consumer's because `createCodeBlock`, `createTabs` and
   * `createMapEmbed` all take that design system's class names and icons — and
   * `createMapEmbed` needs its API route to follow a shortened link. What is
   * shared is the twelve entries around them and how each is configured.
   */
  nodes?: readonly AnyExtension[];
}

/**
 * The editor's extension set.
 *
 * `codeBlock: false` on StarterKit is load-bearing: the consumer registers its
 * own via `createCodeBlock`, and leaving StarterKit's in place would give the
 * schema two nodes claiming the same name. Headings stop at h2 — the page title
 * is the only h1 a wiki page has.
 */
function wikiEditorExtensions({
  placeholder = '',
  nodes = [],
}: WikiEditorExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({ heading: { levels: [2, 3, 4] }, codeBlock: false }),
    wikiLink,
    TiptapImage.configure({
      inline: false,
      allowBase64: true,
      HTMLAttributes: { class: 'rounded-lg max-w-full' },
    }),
    TiptapTable.configure({ resizable: false, HTMLAttributes: { class: 'tiptap-table' } }),
    TiptapTableRow,
    TiptapTableCell.configure({ HTMLAttributes: { class: 'p-2' } }),
    TiptapTableHeader.configure({ HTMLAttributes: { class: 'p-2 font-semibold bg-surface-1' } }),
    ...nodes,
    Placeholder.configure({ placeholder }),
  ] as AnyExtension[];
}

// ---- pasted URLs ------------------------------------------------------------

const YOUTUBE = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/;
const TWEET = /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/;
const SHORT_MAP = /maps\.app\.goo\.gl|goo\.gl\/maps/;

/**
 * Turn a pasted URL into the richest node that fits it, falling back to a bare
 * iframe. Order matters: a YouTube URL is also a valid iframe source, so the
 * specific cases have to be tried before the general one.
 *
 * A shortened map link inserts IMMEDIATELY with `about:blank` and swaps its
 * `src` once the redirect resolves. Pasting must not block on a network hop,
 * and the node has to already exist for the reader to see anything happen. The
 * swap re-finds the node by its `url` attribute rather than caching a position,
 * because every keystroke between the paste and the resolve moves it.
 */
function insertEmbed(
  editor: Editor,
  url: string,
  { resolveMapUrl }: { resolveMapUrl: (url: string) => Promise<string | null> },
): void {
  const yt = url.match(YOUTUBE);
  if (yt) {
    editor.chain().focus().setYoutubeVideo({ src: url }).run();
    return;
  }

  const tw = url.match(TWEET);
  if (tw) {
    editor.chain().focus().insertContent({ type: 'twitterEmbed', attrs: { tweetId: tw[1], url } }).run();
    return;
  }

  const mapSrc = toMapEmbedUrl(url);
  if (mapSrc) {
    editor.chain().focus().insertContent({ type: 'mapEmbed', attrs: { src: mapSrc, url } }).run();
    return;
  }

  if (SHORT_MAP.test(url)) {
    editor.chain().focus().insertContent({ type: 'mapEmbed', attrs: { src: 'about:blank', url } }).run();
    void resolveMapUrl(url).then(src => {
      if (!src) return;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'mapEmbed' && node.attrs.url === url && node.attrs.src === 'about:blank') {
          editor.chain().setNodeSelection(pos).updateAttributes('mapEmbed', { src }).run();
          return false;
        }
        return true;
      });
    });
    return;
  }

  editor.chain().focus().insertContent({ type: 'iframe', attrs: { src: url } }).run();
}

/** The table controls, shown only while the selection is inside a table. */
export const TABLE_ACTIONS: ReadonlyArray<[command: string, label: string, danger?: boolean]> = [
  ['addColumnAfter', 'Add column'],
  ['addRowAfter', 'Add row'],
  ['deleteColumn', 'Remove column', true],
  ['deleteRow', 'Remove row', true],
  ['deleteTable', 'Remove table', true],
];

/** `editor.isActive` as a toolbar button's `active` descriptor expresses it. */
export type ActiveDescriptor = string | [string, Record<string, unknown>];

/** Run one of `TABLE_ACTIONS` — the one place the command name is looked up untyped. */
export function runTableAction(editor: Editor, command: string): void {
  const chain = editor.chain().focus() as unknown as Record<string, (() => { run: () => boolean }) | undefined>;
  chain[command]?.().run();
}

export type ToolbarKey =
  | 'undo'
  | 'redo'
  | 'bold'
  | 'italic'
  | 'code'
  | 'link'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote'
  | 'codeBlock'
  | 'divider'
  | 'table'
  | 'tabs';

export interface ToolbarAction {
  key: ToolbarKey;
  /** What a screen reader announces and a tooltip shows. */
  label: string;
  /** The node, mark or command the editor needs for the button to show. */
  needs: string;
  active?: ActiveDescriptor;
  /** Absent on `link`, which needs a URL: call `withUrl` once you have one. */
  run?: (editor: Editor) => void;
  withUrl?: (editor: Editor, url: string) => void;
}

const heading = (level: 2 | 3 | 4, label: string): ToolbarAction => ({
  key: `h${level}`,
  label,
  needs: 'heading',
  active: ['heading', { level }],
  run: e => e.chain().focus().toggleHeading({ level }).run(),
});

/**
 * The formatting commands, labelled, in toolbar order. Three toolbars ran these
 * identically and two titled their buttons with the internal key – a screen
 * reader said "codeBlock", and inline code and code block shared one icon and
 * one name.
 *
 * @internal
 */
export const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
  { key: 'undo', label: 'Undo', needs: 'undo', run: e => e.chain().focus().undo().run() },
  { key: 'redo', label: 'Redo', needs: 'redo', run: e => e.chain().focus().redo().run() },
  { key: 'bold', label: 'Bold', needs: 'bold', active: 'bold', run: e => e.chain().focus().toggleBold().run() },
  { key: 'italic', label: 'Italic', needs: 'italic', active: 'italic', run: e => e.chain().focus().toggleItalic().run() },
  { key: 'code', label: 'Inline code', needs: 'code', active: 'code', run: e => e.chain().focus().toggleCode().run() },
  { key: 'link', label: 'Link', needs: 'link', active: 'link', withUrl: (e, href) => e.chain().focus().setLink({ href }).run() },
  heading(2, 'Heading'),
  heading(3, 'Subheading'),
  heading(4, 'Small heading'),
  { key: 'bulletList', label: 'Bulleted list', needs: 'bulletList', active: 'bulletList', run: e => e.chain().focus().toggleBulletList().run() },
  { key: 'orderedList', label: 'Numbered list', needs: 'orderedList', active: 'orderedList', run: e => e.chain().focus().toggleOrderedList().run() },
  { key: 'blockquote', label: 'Quote', needs: 'blockquote', active: 'blockquote', run: e => e.chain().focus().toggleBlockquote().run() },
  { key: 'codeBlock', label: 'Code block', needs: 'codeBlock', active: 'codeBlock', run: e => e.chain().focus().toggleCodeBlock().run() },
  {
    key: 'table',
    label: 'Table',
    needs: 'table',
    active: 'table',
    run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    key: 'tabs',
    label: 'Tabs',
    needs: 'tabGroup',
    active: 'tabGroup',
    // Two, not one: a group of one is a heading with extra steps, and the node
    // refuses to delete its last tab anyway.
    run: e =>
      e
        .chain()
        .focus()
        .insertContent({
          type: 'tabGroup',
          content: [1, 2].map(n => ({ type: 'tabItem', attrs: { title: `Tab ${n}` }, content: [{ type: 'paragraph' }] })),
        })
        .run(),
  },
  { key: 'divider', label: 'Divider', needs: 'horizontalRule', run: e => e.chain().focus().setHorizontalRule().run() },
];

/** The groups the toolbar draws, a divider between each. Upload and embed lead the last. */
const GROUPS: readonly (readonly ToolbarKey[])[] = [
  ['undo', 'redo'],
  ['bold', 'italic', 'code', 'link'],
  ['h2', 'h3', 'h4'],
  ['bulletList', 'orderedList', 'blockquote', 'codeBlock'],
  ['table', 'tabs', 'divider'],
];

/**
 * Whether the editor can do what an action does: its schema has the node or
 * mark, or it has the command, and a heading button's level is one the editor
 * allows. What a toolbar shows follows from the extensions an editor was
 * built with, so no app keeps a list of buttons beside its list of nodes.
 *
 * @internal
 */
export function supports(editor: Editor, { key, needs }: ToolbarAction): boolean {
  const { nodes, marks } = editor.schema;
  if (needs === 'heading') {
    const levels = editor.extensionManager.extensions.find(e => e.name === 'heading')?.options.levels as number[] | undefined;
    return !!nodes.heading && !!levels?.includes(Number(key.slice(1)));
  }
  return !!(nodes[needs] || marks[needs] || needs in editor.commands);
}

/** The editor redrawn on every change, for a toolbar whose editor is not the component's own. */
function useTransactions(editor: Editor | null): void {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', redraw);
    return () => {
      editor.off('transaction', redraw);
    };
  }, [editor]);
}

/**
 * A toolbar button that says what it is and whether it is on. `aria-pressed`
 * is right here, unlike on a facet link: this is a toggle.
 */
export function ToolbarButton({
  label,
  pressed,
  onPress,
  className,
  children,
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={pressed} className={className} onClick={onPress}>
      {children}
    </button>
  );
}

export interface WikiToolbarProps {
  /** The editor it drives; with none it shows only `children`. */
  editor: Editor | null;
  /** `useUrlPrompt`'s state: the link button opens it, and shows pressed while it is open. */
  prompt: UrlPromptState;
  /** Shows the upload button where the editor takes images: `useWikiEditor`'s `triggerUpload`. */
  onUpload?: () => void;
  icons: Partial<Record<ToolbarKey | 'unlink' | 'upload' | 'embed', ReactNode>>;
  classNames?: {
    toolbar?: string;
    button?: string;
    /** Added to a button that is on. */
    pressed?: string;
    /** Drawn between groups, and before the table controls. */
    divider?: string;
    /** A table control, which is a word rather than an icon. */
    tableButton?: string;
    /** Added to the table controls that delete. */
    danger?: string;
  };
  /** After the buttons: a hint, or controls of the app's own. */
  children?: ReactNode;
}

/**
 * The formatting bar. It shows what the editor can do and nothing else: every
 * command whose node, mark or command the editor has (`supports`), grouped,
 * then upload where it takes images and embed where it has embed nodes, then
 * the table controls while the cursor is in a table. Remove link follows Link
 * while the cursor is in a link. The same bar drives a whole article, a one-line
 * field and an editor shared between blocks; which icons and classes are the
 * caller's. Every button is a `ToolbarButton`, named and `aria-pressed`.
 */
export function WikiToolbar({ editor, prompt, onUpload, icons, classNames: c = {}, children }: WikiToolbarProps) {
  useTransactions(editor);
  if (!editor || editor.isDestroyed) {
    return (
      <div className={c.toolbar} role="toolbar" aria-label="Text formatting">
        {children}
      </div>
    );
  }
  const button = (a: ToolbarAction) => {
    const pressed = (!!a.active && (typeof a.active === 'string' ? editor.isActive(a.active) : editor.isActive(...a.active))) || (a.key === 'link' && prompt.kind === 'link');
    return (
      <ToolbarButton
        key={a.key}
        label={a.label}
        pressed={a.active ? pressed : undefined}
        onPress={() => (a.run ? a.run(editor) : prompt.toggle('link'))}
        className={cx(c.button, pressed && c.pressed)}
      >
        {icons[a.key]}
      </ToolbarButton>
    );
  };
  const extra: Partial<Record<ToolbarKey, ReactNode>> = {
    link: editor.isActive('link') && (
      <ToolbarButton key="unlink" label="Remove link" onPress={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()} className={c.button}>
        {icons.unlink}
      </ToolbarButton>
    ),
  };
  const insert = [
    onUpload && editor.schema.nodes.image && (
      <ToolbarButton key="upload" label="Picture" onPress={onUpload} className={c.button}>
        {icons.upload}
      </ToolbarButton>
    ),
    (editor.schema.nodes.youtube || editor.schema.nodes.iframe) && (
      <ToolbarButton
        key="embed"
        label="Video, post or map"
        pressed={prompt.kind === 'embed'}
        onPress={() => prompt.toggle('embed')}
        className={cx(c.button, prompt.kind === 'embed' && c.pressed)}
      >
        {icons.embed}
      </ToolbarButton>
    ),
  ].filter(Boolean);
  const groups = GROUPS.map((keys, i) => [
    ...(i === GROUPS.length - 1 ? insert : []),
    ...keys.flatMap(key => TOOLBAR_ACTIONS.filter(a => a.key === key && supports(editor, a)).flatMap(a => [button(a), extra[a.key]])),
  ].filter(Boolean)).filter(g => g.length);
  return (
    <div className={c.toolbar} role="toolbar" aria-label="Text formatting">
      {groups.map((g, i) => (
        <Fragment key={i}>
          {i > 0 && c.divider && <span className={c.divider} aria-hidden />}
          {g}
        </Fragment>
      ))}
      {editor.isActive('table') && (
        <>
          <span className={c.divider} aria-hidden />
          {TABLE_ACTIONS.map(([command, label, danger]) => (
            <button key={command} type="button" className={cx(c.tableButton, danger && c.danger)} onClick={() => runTableAction(editor, command)}>
              {label}
            </button>
          ))}
        </>
      )}
      {children}
    </div>
  );
}

// ---- the address field ------------------------------------------------------

export interface UrlPromptFieldProps {
  prompt: UrlPromptState;
  /** The link field's placeholder, where the wiki's own paths differ from a full address. */
  placeholders?: { link?: string };
  classNames?: { row?: string; input?: string; apply?: string; cancel?: string };
}

/**
 * The address field under a toolbar, open while `prompt.kind` is set: Enter
 * applies, Escape closes, and an emptied link address unlinks.
 */
export function UrlPromptField({ prompt, placeholders = {}, classNames: c = {} }: UrlPromptFieldProps) {
  if (!prompt.kind) return null;
  const link = prompt.kind === 'link';
  return (
    <div className={c.row}>
      <input
        autoFocus
        type="text"
        inputMode="url"
        autoCapitalize="none"
        className={c.input}
        aria-label={link ? 'Link address' : 'Embed address'}
        placeholder={link ? (placeholders.link ?? 'https://… (empty removes the link)') : 'A YouTube, X, Google Maps or Apple Maps link'}
        value={prompt.value}
        onChange={e => prompt.setValue(e.target.value)}
        onKeyDown={prompt.onKeyDown}
      />
      <button type="button" className={c.apply} onClick={prompt.apply}>
        {link ? 'Apply' : 'Embed'}
      </button>
      <button type="button" className={c.cancel} onClick={prompt.close}>
        Cancel
      </button>
    </div>
  );
}

export type UrlPromptKind = 'link' | 'embed';

/**
 * What a link or embed field does with its address. A link sets or replaces
 * the link the cursor is in, across the whole link rather than the collapsed
 * selection, and an emptied address takes it off while keeping the text. An
 * embed with no address does nothing.
 *
 * @internal
 */
export function applyUrlPrompt(
  editor: Editor,
  kind: UrlPromptKind,
  url: string,
  { resolveMapUrl }: { resolveMapUrl: (url: string) => Promise<string | null> },
): void {
  const href = url.trim();
  if (kind === 'embed') {
    if (href) insertEmbed(editor, href, { resolveMapUrl });
    return;
  }
  const chain = editor.chain().focus().extendMarkRange('link');
  (href ? chain.setLink({ href }) : chain.unsetLink()).run();
}

export interface UrlPromptState {
  /** The open field, or null. */
  kind: UrlPromptKind | null;
  value: string;
  setValue: (value: string) => void;
  /** Open the field, or close it when it is already open on this kind. */
  toggle: (kind: UrlPromptKind) => void;
  close: () => void;
  /** `applyUrlPrompt` with the field's address, then close. */
  apply: () => void;
  /** Enter applies and Escape closes: the field's `onKeyDown`. */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The state of a link or embed address field under a toolbar, in place of a
 * `window.prompt`, which blocks the page and cannot show the link the cursor is
 * already in. Three editors had written this, and only one had both of what it
 * needs: a link field that opens on the current address, and an emptied one
 * that unlinks. The field closes when the editor it serves changes, since a
 * toolbar shared between blocks would otherwise apply it to the wrong one.
 *
 * The markup stays with the caller: an input bound to `value`, `setValue` and
 * `onKeyDown`, and buttons calling `apply` and `close`.
 */
export function useUrlPrompt(
  editor: Editor | null,
  options: { resolveMapUrl: (url: string) => Promise<string | null> },
): UrlPromptState {
  const [state, setState] = useState<{ kind: UrlPromptKind; value: string } | null>(null);
  const latest = useRef({ editor, state, options });
  useEffect(() => {
    latest.current = { editor, state, options };
  });
  useEffect(() => setState(null), [editor]);

  const toggle = useCallback((kind: UrlPromptKind) => {
    const { editor, state } = latest.current;
    if (state?.kind === kind) return setState(null);
    const href = kind === 'link' ? (editor?.getAttributes('link').href as string | undefined) : undefined;
    setState({ kind, value: href ?? '' });
  }, []);
  const close = useCallback(() => setState(null), []);
  const setValue = useCallback((value: string) => setState(s => (s ? { ...s, value } : s)), []);
  const apply = useCallback(() => {
    const { editor, state, options } = latest.current;
    if (editor && state) applyUrlPrompt(editor, state.kind, state.value, options);
    setState(null);
  }, []);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    },
    [apply, close],
  );

  return { kind: state?.kind ?? null, value: state?.value ?? '', setValue, toggle, close, apply, onKeyDown };
}

// ---- the editor -------------------------------------------------------------

/**
 * An `uploadImage` that POSTs the file as `file` form data and reads `{ url }`
 * back. Two editors carried it character for character, `alert` included.
 */
export function uploadImageTo(endpoint: string): (file: File) => Promise<string | null> {
  return async file => {
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) {
        alert(body.error || 'Upload failed');
        return null;
      }
      return body.url ?? null;
    } catch {
      alert('Upload failed');
      return null;
    }
  };
}

export interface WikiEditorOptions {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  nodes?: readonly AnyExtension[];
  /** The prose class the editor body renders under. */
  proseClass: string;
  /** Upload a chosen file, returning its URL or null. The route is the app's. */
  uploadImage: (file: File) => Promise<string | null>;
  /** Debounce before `onChange` fires, in ms. */
  debounceMs?: number;
}

export interface WikiEditorState {
  editor: Editor | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  isUploading: boolean;
  handleFileChange: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  /** Open the file picker — what an upload toolbar button calls. */
  triggerUpload: () => void;
}

/**
 * The editor and its upload plumbing. `WikiToolbar` given the editor draws
 * the buttons its extensions allow; the icons and classes are the app's.
 */
export function useWikiEditor({
  value,
  onChange,
  placeholder = '',
  nodes = [],
  proseClass,
  uploadImage,
  debounceMs = 150,
}: WikiEditorOptions): WikiEditorState {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const initialValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // An edit made and not yet reported. `onUpdate` fires for edits only, never
  // for the `setContent` that loads the stored value.
  const pendingRef = useRef(false);

  // Written AFTER render, not during: a ref mutated mid-render can tear under
  // concurrent rendering. Only read from events and timeouts, which run later.
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const extensions = useMemo(
    () => wikiEditorExtensions({ placeholder, nodes }),
    // `nodes` is built with `useMemo` by the consumer; rebuilding the array on
    // every render would tear the editor down and lose the selection.
    [placeholder, nodes],
  );

  const editor = useEditor({
    extensions,
    editorProps: {
      attributes: { class: `outline-none focus:outline-none ${proseClass} min-h-20` },
      transformPastedHTML: cleanPastedHtml,
    },
    onUpdate: ({ editor }) => {
      clearTimeout(debounceRef.current);
      pendingRef.current = true;
      debounceRef.current = setTimeout(() => {
        pendingRef.current = false;
        onChangeRef.current(editor.getHTML());
      }, debounceMs);
    },
    // Flush a pending edit on blur, so a quick Save — which blurs the editor
    // before the click fires — never drops the final keystroke. A blur with no
    // edit reports nothing.
    onBlur: ({ editor }) => {
      clearTimeout(debounceRef.current);
      if (!pendingRef.current) return;
      pendingRef.current = false;
      onChangeRef.current(editor.getHTML());
    },
    immediatelyRender: false,
    onCreate: ({ editor }) => {
      if (initialValueRef.current) {
        queueMicrotask(() => editor.commands.setContent(initialValueRef.current));
      }
    },
  });

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // Accept an outside change, but never while the author is typing into it.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (editor.getHTML() !== value) editor.commands.setContent(value);
  }, [value, editor]);

  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !editor) return;
      setIsUploading(true);
      const url = await uploadImage(file);
      if (url) editor.chain().focus().setImage({ src: url }).run();
      setIsUploading(false);
      // Cleared so choosing the same file twice in a row still fires a change.
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [editor, uploadImage],
  );

  const triggerUpload = useCallback(() => fileInputRef.current?.click(), []);

  return { editor, fileInputRef, isUploading, handleFileChange, triggerUpload };
}

// ---- one line ---------------------------------------------------------------

/** What a one-line field may keep. With none, its value is plain text. */
export type LineMark = 'bold' | 'italic' | 'link';

// A line's whole document is the line, so Enter has nowhere to go.
const LineDoc = TiptapNode.create({
  name: 'doc',
  topNode: true,
  content: 'text*',
  addKeyboardShortcuts: () => ({ Enter: () => true, 'Shift-Enter': () => true }),
});

/** A paste as one line: its blocks and breaks run on with a space, before the schema keeps only the marks the line takes. */
const pastedLine = (html: string) => cleanPastedHtml(html).replace(/<\/(p|h[1-6]|li|div|blockquote|tr|td|th)>|<br\s*\/?>/gi, ' ');

export interface WikiLineProps {
  as: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div' | 'small' | 'figcaption';
  value: string;
  onChange: (value: string) => void;
  /** Shown while it is empty, and its accessible name. */
  placeholder: string;
  marks?: readonly LineMark[];
  className?: string;
  /** The editor, as it takes focus: what a toolbar shared between fields claims. */
  onFocus?: (editor: Editor) => void;
}

/**
 * One line of words – a title, a heading, a caption, a button – edited in the
 * element that shows it, so it reads as the page draws it. Its schema is the
 * line and the `marks` it may keep, so nothing else can get in: no list from a
 * typed "- ", no heading from a paste. Its value is that HTML, or plain text
 * when it keeps no marks. It has its own undo, and `WikiToolbar` given its
 * editor shows undo and its marks. `base.css` gives it its placeholder.
 */
export function WikiLine({ as: Tag, value, onChange, placeholder, marks = [], className, onFocus }: WikiLineProps) {
  const ref = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const latest = useRef({ onChange, onFocus });
  useEffect(() => {
    latest.current = { onChange, onFocus };
  });
  const key = marks.join();
  const out = (e: Editor) => (key ? e.getHTML() : e.getText()).replace(/\s+/g, ' ');
  const content = (v: string) => (key ? v : { type: 'doc', content: v ? [{ type: 'text', text: v }] : [] });

  // Mounted on the element itself: the element is the editable root.
  useLayoutEffect(() => {
    const has = (m: LineMark) => key.split(',').includes(m);
    const e = new TiptapEditor({
      element: { mount: ref.current! } as unknown as Element,
      extensions: [
        LineDoc,
        StarterKit.configure({
          document: false,
          paragraph: false,
          heading: false,
          blockquote: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          codeBlock: false,
          code: false,
          horizontalRule: false,
          hardBreak: false,
          strike: false,
          dropcursor: false,
          gapcursor: false,
          ...(has('bold') ? {} : { bold: false }),
          ...(has('italic') ? {} : { italic: false }),
        }),
        ...(has('link') ? [wikiLink] : []),
      ],
      content: content(value),
      editorProps: { transformPastedHTML: pastedLine, transformPastedText: t => t.replace(/\s+/g, ' ') },
      onUpdate: ({ editor }) => latest.current.onChange(out(editor)),
      onFocus: ({ editor }) => latest.current.onFocus?.(editor),
    });
    setEditor(e);
    return () => e.destroy();
    // The value is read once here; the effect below takes later ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Take a change from outside, never one the field itself just reported.
  useEffect(() => {
    if (editor && !editor.isFocused && out(editor) !== value) editor.commands.setContent(content(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, value]);

  return <Tag ref={ref as RefObject<HTMLParagraphElement>} className={className} data-wiki-line="" data-placeholder={placeholder} aria-label={placeholder} />;
}
