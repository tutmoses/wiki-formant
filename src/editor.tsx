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
import type { AnyExtension, Editor } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from 'react';
import { toMapEmbedUrl } from './maps.js';

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
    TiptapLink.configure({ openOnClick: false, HTMLAttributes: { class: 'link' } }),
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
export function insertEmbed(
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
  ['addColumnAfter', '+Col'],
  ['addRowAfter', '+Row'],
  ['deleteColumn', '-Col', true],
  ['deleteRow', '-Row', true],
  ['deleteTable', '-Tbl', true],
];

/** `editor.isActive` as a toolbar button's `active` descriptor expresses it. */
export type ActiveDescriptor = string | [string, Record<string, unknown>];

/** Run one of `TABLE_ACTIONS` — the one place the command name is looked up untyped. */
export function runTableAction(editor: Editor, command: string): void {
  const chain = editor.chain().focus() as unknown as Record<string, (() => { run: () => boolean }) | undefined>;
  chain[command]?.().run();
}

export type ToolbarKey =
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
  active?: ActiveDescriptor;
  /** Absent on `link`, which needs a URL: call `withUrl` once you have one. */
  run?: (editor: Editor) => void;
  withUrl?: (editor: Editor, url: string) => void;
}

/**
 * The formatting commands, labelled. Three toolbars ran these identically and
 * two titled their buttons with the internal key — a screen reader said
 * "codeBlock", and inline code and code block shared one icon and one name.
 * Upload and embed stay with the caller: they are the parts that differ.
 */
export const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
  { key: 'bold', label: 'Bold', active: 'bold', run: e => e.chain().focus().toggleBold().run() },
  { key: 'italic', label: 'Italic', active: 'italic', run: e => e.chain().focus().toggleItalic().run() },
  { key: 'code', label: 'Inline code', active: 'code', run: e => e.chain().focus().toggleCode().run() },
  { key: 'link', label: 'Link', active: 'link', withUrl: (e, href) => e.chain().focus().setLink({ href }).run() },
  { key: 'h2', label: 'Heading 2', active: ['heading', { level: 2 }], run: e => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { key: 'h3', label: 'Heading 3', active: ['heading', { level: 3 }], run: e => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { key: 'h4', label: 'Heading 4', active: ['heading', { level: 4 }], run: e => e.chain().focus().toggleHeading({ level: 4 }).run() },
  { key: 'bulletList', label: 'Bulleted list', active: 'bulletList', run: e => e.chain().focus().toggleBulletList().run() },
  { key: 'orderedList', label: 'Numbered list', active: 'orderedList', run: e => e.chain().focus().toggleOrderedList().run() },
  { key: 'blockquote', label: 'Quote', active: 'blockquote', run: e => e.chain().focus().toggleBlockquote().run() },
  { key: 'codeBlock', label: 'Code block', active: 'codeBlock', run: e => e.chain().focus().toggleCodeBlock().run() },
  { key: 'divider', label: 'Divider', run: e => e.chain().focus().setHorizontalRule().run() },
  {
    key: 'table',
    label: 'Table',
    active: 'table',
    run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    key: 'tabs',
    label: 'Tabs',
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
];

/** The actions a toolbar shows, in the order it shows them. */
export function toolbarActions(keys: readonly ToolbarKey[]): ToolbarAction[] {
  return keys.flatMap(key => TOOLBAR_ACTIONS.filter(a => a.key === key));
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
  isActive: (a?: ActiveDescriptor) => boolean;
}

/**
 * The editor, its upload plumbing and the state a toolbar reads.
 *
 * The toolbar itself stays with the consumer: the two wikis differ on which
 * buttons exist, which icon set draws them, and whether a link is entered in a
 * `window.prompt` or an inline field. Those are real differences. What they had
 * no business differing on is everything below.
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
      debounceRef.current = setTimeout(() => onChangeRef.current(editor.getHTML()), debounceMs);
    },
    // Flush the pending debounce on blur, so a quick Save — which blurs the
    // editor before the click fires — never drops the final keystroke.
    onBlur: ({ editor }) => {
      clearTimeout(debounceRef.current);
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

  const isActive = useCallback(
    (a?: ActiveDescriptor) =>
      a ? Boolean(Array.isArray(a) ? editor?.isActive(a[0], a[1]) : editor?.isActive(a)) : false,
    [editor],
  );

  return { editor, fileInputRef, isUploading, handleFileChange, triggerUpload, isActive };
}
