'use client';

// react.tsx — the collapsible wiki sidebar, and the table of contents inside it.
//
// This is the one part of the package that needs React, so it is the one part
// behind its own subpath: `wiki-formant/react`. React is an OPTIONAL PEER
// dependency, so a consumer that only wants the taxonomy or the MCP transport
// still installs a package with no runtime dependencies at all.
//
// What is shared here is behaviour, not appearance. Every class name is passed
// in, because the three wikis style their rails differently and always will;
// what they should not differ on is what the rail DOES. Icons are passed in for
// the same reason — and because a component library that hardcodes an icon set
// makes its consumers install that icon set.
//
// Two bugs are fixed here rather than propagated. Both were in the version this
// was lifted from:
//
//   1. `useEffect(() => setOpen(!isMobile), [isMobile])` ran on every matchMedia
//      change, so resizing a window across the breakpoint silently discarded a
//      collapse the reader had chosen. The breakpoint now supplies the DEFAULT
//      only, and never overrides a choice already made.
//   2. The store started closed and an effect opened it on mount, so every
//      desktop load flashed a closed rail before opening it. SSR cannot read
//      localStorage, so no amount of React fixes this on its own: the answer is
//      `sidebarBootScript`, a blocking inline script that stamps the remembered
//      state on <html> before first paint. The hook keeps that attribute in
//      sync afterwards, so CSS has one source of truth either side of hydration.

import { resolveSidebarOpen, SIDEBAR_ATTRIBUTE } from './sidebar.js';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

// ---- collapse state ---------------------------------------------------------

export interface SidebarOptions {
  /**
   * Where the reader's choice is remembered, in `localStorage`. Give each wiki
   * its own key; they are different sites and may deserve different answers.
   */
  storageKey?: string;
  /** Below this width (px) the rail defaults to closed. */
  breakpoint?: number;
}

export interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** True below `breakpoint`. Drives "close the rail after following a link". */
  isMobile: boolean;
  /**
   * False until the effect has read storage and matchMedia. Render the rail
   * without its open/closed transition while this is false, so a remembered
   * closed rail does not animate shut on every load.
   */
  ready: boolean;
}

const readStored = (key: string): boolean | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : raw === '1';
  } catch {
    // Private browsing, or site data blocked. A rail that cannot remember is
    // fine; a rail that throws on load is not.
    return null;
  }
};

/**
 * Collapse state for a wiki rail: remembered across loads, defaulted from the
 * viewport only when the reader has never chosen.
 *
 * The reader's choice outranks the breakpoint. Someone who collapses the rail
 * on a laptop and then narrows the window has still collapsed the rail.
 */
export function useCollapsibleSidebar(options: SidebarOptions = {}): SidebarState {
  const { storageKey = 'wiki:sidebar', breakpoint = 1024 } = options;

  // Start open on the server and on the first client paint. SSR has no viewport
  // and no storage, so any other guess is a guaranteed mismatch on some loads.
  const [open, setOpenState] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [ready, setReady] = useState(false);
  // Set as soon as the reader touches the control, so a later viewport change
  // cannot overwrite what they asked for.
  const chosen = useRef(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const stored = readStored(storageKey);

    const apply = (matches: boolean) => {
      setIsMobile(matches);
      // The breakpoint supplies a default, never an override. This is bug 1.
      setOpenState(current =>
        resolveSidebarOpen({ chosen: chosen.current, current, stored, isMobile: matches }),
      );
    };

    apply(mql.matches);
    setReady(true);

    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [storageKey, breakpoint]);

  const setOpen = useCallback(
    (next: boolean) => {
      chosen.current = true;
      setOpenState(next);
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* storage unavailable — the choice still holds for this page */
      }
    },
    [storageKey],
  );

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  // One source of truth either side of hydration: the boot script writes this
  // attribute before first paint, and from here on the hook owns it.
  useEffect(() => {
    document.documentElement.setAttribute(SIDEBAR_ATTRIBUTE, open ? 'open' : 'closed');
  }, [open]);

  return { open, setOpen, toggle, isMobile, ready };
}

// ---- sharing that state across the layout -----------------------------------

// The rail and the button that toggles it are rarely siblings — the button
// usually lives in the header — so the state has to span them. A context is the
// smallest thing that does, and it means a consumer needs no store of its own.

const SidebarContext = createContext<SidebarState | null>(null);

export interface SidebarProviderProps extends SidebarOptions {
  children: ReactNode;
}

/** Wrap the layout that contains both the rail and its toggle. */
export function SidebarProvider({ children, ...options }: SidebarProviderProps) {
  const state = useCollapsibleSidebar(options);
  return createElement(SidebarContext.Provider, { value: state }, children);
}

/**
 * The rail's collapse state. Throws outside a provider rather than silently
 * handing back a second, unconnected copy — two sources of truth for one rail
 * is the failure this context exists to prevent.
 */
export function useSidebar(): SidebarState {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within a <SidebarProvider>');
  return ctx;
}

// ---- table of contents ------------------------------------------------------

export interface TocHeading {
  id: string;
  text: string;
  /** 1 for `<h1>`, 2 for `<h2>`, and so on. */
  level: number;
}

export interface TocClassNames {
  root?: string;
  button?: string;
  label?: string;
  list?: string;
  item?: string;
  /** Applied alongside `item` on the section currently under the viewport top. */
  itemActive?: string;
}

export interface TableOfContentsProps {
  /**
   * The element holding the article. A wiki whose content streams in as blocks
   * has to read the DOM, which is why a selector is the default route — by the
   * time the rail mounts, the article may not be there yet.
   *
   * Optional when `headings` is given: a wiki that renders its article on the
   * server already knows them and should not pay for a MutationObserver to
   * rediscover what it just wrote.
   */
  containerSelector?: string;
  /**
   * Headings known ahead of time. Supplying these skips the DOM scan entirely;
   * scroll-spy still runs, since that needs the rendered elements either way.
   */
  headings?: TocHeading[];
  /** Re-query and re-observe when this changes. Pass the pathname. */
  resetKey?: string;
  classNames?: TocClassNames;
  /** Rendered before the label. Receives the current expanded state. */
  icon?: (expanded: boolean) => ReactNode;
  label?: string;
  /**
   * Mint an id for a heading that lacks one. Wikis that inject ids server-side
   * (see `wiki-formant/headings`) should leave this off — an id is a URL, and
   * one minted in the browser is not the one the server published.
   */
  slug?: (text: string) => string;
  /**
   * CSS custom property holding the sticky header's height, used to place the
   * scroll-spy line. e.g. `'--header-height'`.
   */
  offsetVar?: string;
  /** Fallback offset in px when `offsetVar` is unset or unparseable. */
  offsetFallback?: number;
  /** Indent per heading level, in rem. Set 0 for a flat list. */
  indentRem?: number;
  /** Rendered instead of nothing when the article has no headings. */
  empty?: ReactNode;
}

const sameHeadings = (a: TocHeading[], b: TocHeading[]): boolean =>
  a.length === b.length && a.every((h, i) => h.id === b[i]!.id && h.text === b[i]!.text);

/**
 * An "on this page" rail with scroll-spy, read from the rendered article.
 *
 * Both wikis this came from had written the same thing: a debounced
 * MutationObserver to survive content arriving late, an IntersectionObserver to
 * track the section under the viewport top, and the same reference-stability
 * trick so an unrelated DOM mutation (a price ticker, an RSS feed) does not tear
 * the observer down.
 */
export function TableOfContents({
  containerSelector,
  headings: providedHeadings,
  resetKey,
  classNames = {},
  icon,
  label = 'On this page',
  slug,
  offsetVar,
  offsetFallback = 64,
  indentRem = 0.75,
  empty = null,
}: TableOfContentsProps) {
  const [scanned, setScanned] = useState<TocHeading[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [activeId, setActiveId] = useState('');

  const headings = providedHeadings ?? scanned;

  useEffect(() => {
    // Nothing to scan for when the caller already knows the headings.
    if (providedHeadings || !containerSelector) return;
    let timer: ReturnType<typeof setTimeout>;

    const update = () => {
      clearTimeout(timer);
      // Debounced: block content can arrive in bursts, and re-reading the whole
      // article per mutation is what makes a rail janky.
      timer = setTimeout(() => {
        const root = document.querySelector(containerSelector);
        if (!root) return;
        const used = new Set<string>();
        const next: TocHeading[] = [];

        for (const el of Array.from(root.querySelectorAll('h1, h2, h3'))) {
          const text = el.textContent?.trim() ?? '';
          if (!text) continue;
          let id = el.id;
          if (!id) {
            if (!slug) continue; // ids are the server's business here
            const base = slug(text) || 'section';
            id = base;
            let n = 2;
            while (used.has(id) || document.getElementById(id)) id = `${base}-${n++}`;
            el.id = id;
          }
          used.add(id);
          next.push({ id, text, level: Number(el.tagName[1]) });
        }

        // Keep the same array reference when nothing changed, so the scroll-spy
        // effect below is not torn down by an unrelated mutation.
        setScanned(prev => (sameHeadings(prev, next) ? prev : next));
      }, 200);
    };

    update();
    const root = document.querySelector(containerSelector);
    const observer = new MutationObserver(update);
    if (root) observer.observe(root, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [containerSelector, resetKey, slug, providedHeadings]);

  useEffect(() => {
    if (!headings.length) return;
    const order = new Map(headings.map((h, i) => [h.id, i]));
    const visible = new Set<string>();

    const styles = getComputedStyle(document.documentElement);
    const rem = parseFloat(styles.fontSize) || 16;
    const raw = offsetVar ? styles.getPropertyValue(offsetVar).trim() : '';
    // A custom property may be in rem or px; both appear across these wikis.
    const parsed = parseFloat(raw);
    const offset = !raw || Number.isNaN(parsed)
      ? offsetFallback
      : raw.endsWith('rem') ? parsed * rem : parsed;
    const topOffset = Math.round(offset + rem * 0.5);

    const observer = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        if (!visible.size) return;
        // The earliest visible heading in document order is the section the
        // reader is in, not whichever entry fired last.
        let bestId = '';
        let bestIdx = Infinity;
        for (const id of visible) {
          const idx = order.get(id) ?? Infinity;
          if (idx < bestIdx) {
            bestIdx = idx;
            bestId = id;
          }
        }
        if (bestId) setActiveId(bestId);
      },
      { rootMargin: `-${topOffset}px 0px -75% 0px`, threshold: 0 },
    );

    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [headings, offsetVar, offsetFallback]);

  // Derived, not seeded from an effect: until the observer reports a section,
  // the first heading is the one the reader is in.
  const currentId = useMemo(() => activeId || headings[0]?.id, [activeId, headings]);

  if (!headings.length) return <>{empty}</>;

  return (
    <div className={classNames.root}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className={classNames.button}
        aria-expanded={expanded}
      >
        {icon?.(expanded)}
        <span className={classNames.label}>{label}</span>
      </button>
      {expanded && (
        <nav className={classNames.list} aria-label={label}>
          {headings.map(h => (
            <button
              type="button"
              key={h.id}
              onClick={() => {
                setActiveId(h.id);
                document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' });
              }}
              className={
                currentId === h.id
                  ? [classNames.item, classNames.itemActive].filter(Boolean).join(' ')
                  : classNames.item
              }
              aria-current={currentId === h.id ? 'location' : undefined}
              style={{ paddingLeft: `${(h.level - 1) * indentRem}rem` } as CSSProperties}
            >
              {h.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
