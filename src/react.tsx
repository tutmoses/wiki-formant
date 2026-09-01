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
import { comboboxAria, type ComboboxAria } from './combobox.js';
import {
  Component,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
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

// ---- outside clicks ---------------------------------------------------------

/**
 * Calls `onClose` on any mousedown outside the returned ref's element.
 *
 * The `offsetParent` check is the whole reason this is shared. All three wikis
 * had written this hook; only one had that line, and without it a container
 * that is `display: none` at the current breakpoint still claims outside-clicks
 * — so a tap anywhere on a phone dismisses a popover the reader is looking at,
 * because the hidden desktop copy of it answered first.
 *
 * `onClose` is an effect dependency: wrap it in `useCallback` or hoist it, or
 * the listener is torn down and rebuilt on every render.
 */
export function useClickOutside<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = ref.current;
      if (el && el.offsetParent !== null && !el.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return ref;
}

// ---- typeahead --------------------------------------------------------------

export interface TypeaheadOptions<T> {
  /**
   * Runs the search. MUST be referentially stable — a module function, a server
   * action, or something wrapped in `useCallback` — because it is an effect
   * dependency and an inline arrow re-runs the search on every render.
   *
   * The `signal` is optional to implement: a REST fetcher should forward it, a
   * server action simply declares one parameter and ignores it.
   */
  fetch: (query: string, signal: AbortSignal) => Promise<T[]>;
  onPick: (item: T) => void;
  /** Runs after Escape has cleared the list, for surface-level dismissal. */
  onEscape?: () => void;
  /** Debounce, in ms. */
  delay?: number;
  /** Queries shorter than this never reach `fetch`. */
  minLength?: number;
  /** Remember results per query for this mount. */
  cache?: boolean;
}

export interface TypeaheadState<T> {
  query: string;
  setQuery: (query: string) => void;
  debouncedQuery: string;
  items: T[];
  highlight: number;
  setHighlight: (index: number) => void;
  isSearching: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Drop the results, keep the query. For an outside click. */
  clearItems: () => void;
  /** Drop everything. For a pick, or a closing popover. */
  reset: () => void;
  /**
   * The listbox contract, ready to spread: `inputProps` on the field,
   * `listProps` on the results container, `optionProps(i)` on each row.
   *
   * Pass a `listKey` when one hook feeds more than one rendered list — a header
   * with a desktop and a mobile field renders both into the same document, and
   * one id set across the two duplicates every option id.
   */
  combobox: (listKey?: string, open?: boolean) => ComboboxAria;
}

/**
 * The debounced-search state machine behind every typeahead on these sites.
 *
 * Five surfaces across the three wikis had three implementations, and no two
 * agreed on what a search field does. This is their union, because each had a
 * piece the others were missing:
 *
 *   - a **request-id guard**, so a slow response cannot paint over a newer one.
 *     Two of the five surfaces had no guard at all: type fast enough and the
 *     results you are reading are for a query you have already replaced.
 *   - **keyboard navigation**. Two surfaces had none — the header dropdown of a
 *     wiki whose search is its primary navigation was mouse-only.
 *   - **abort and a per-query cache**, which only the third had. The cache is
 *     per mount, not module-level, so a stale result cannot outlive the page.
 *
 * The debounce is inlined rather than pulled from a package: this one is nine
 * lines, and the point of the package is to have no runtime dependencies.
 */
export function useTypeahead<T>({
  fetch,
  onPick,
  onEscape,
  delay = 200,
  minLength = 1,
  cache = true,
}: TypeaheadOptions<T>): TypeaheadState<T> {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<T[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const requestId = useRef(0);
  const cached = useRef(new Map<string, T[]>());

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), delay);
    return () => clearTimeout(timer);
  }, [query, delay]);

  useEffect(() => {
    const q = debounced.trim();
    if (q.length < minLength) {
      // Bump the id so an in-flight request for a longer query cannot land
      // after the field has been cleared.
      requestId.current++;
      setItems([]);
      setIsSearching(false);
      return;
    }

    const hit = cache ? cached.current.get(q) : undefined;
    if (hit) {
      requestId.current++;
      setItems(hit);
      setHighlight(0);
      setIsSearching(false);
      return;
    }

    const id = ++requestId.current;
    const controller = new AbortController();
    setIsSearching(true);

    fetch(q, controller.signal).then(
      rows => {
        if (id !== requestId.current) return;
        if (cache) cached.current.set(q, rows);
        setItems(rows);
        setHighlight(0);
        setIsSearching(false);
      },
      () => {
        // An abort is the expected path for every superseded query, so it must
        // not surface as an error. A real failure reads as "no results".
        if (id !== requestId.current) return;
        setItems([]);
        setIsSearching(false);
      },
    );

    return () => controller.abort();
  }, [debounced, fetch, minLength, cache]);

  const clearItems = useCallback(() => setItems([]), []);

  const reset = useCallback(() => {
    requestId.current++;
    setQuery('');
    setDebounced('');
    setItems([]);
    setHighlight(0);
    setIsSearching(false);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setItems([]);
      onEscape?.();
      return;
    }
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => (h + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => (h - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = items[highlight];
      if (target) onPick(target);
    }
  };

  // The ids have to be stable per mount and unique per surface; `useId` is what
  // makes a second typeahead on the same page legal.
  const baseId = useId();
  const combobox = useCallback(
    (listKey?: string, open?: boolean) =>
      comboboxAria({ baseId, listKey, count: items.length, highlight, open }),
    [baseId, items.length, highlight],
  );

  return {
    query,
    setQuery,
    debouncedQuery: debounced,
    items,
    highlight,
    setHighlight,
    isSearching,
    onKeyDown,
    clearItems,
    reset,
    combobox,
  };
}

// ---- link preview -----------------------------------------------------------

export interface LinkPreviewOptions<T> {
  /**
   * Which anchors get a card. Both wikis scope this to the article container
   * (`a.closest('.prose-content')`) as well as testing the href, and the scope
   * is exactly the part that differs — so the whole predicate is yours.
   */
  eligible: (anchor: HTMLAnchorElement) => boolean;
  /** Resolve a preview for a href, or null for "no card". REST or server action. */
  fetch: (href: string) => Promise<T | null>;
  /** Must match the class on the element you spread `cardProps` onto. */
  cardClassName?: string;
  cardWidth?: number;
  /** Used to decide whether the card flips above the link. */
  cardHeight?: number;
  /** Hover this long before fetching, in ms. */
  showDelay?: number;
  /** Grace period for the cursor to travel from link to card, in ms. */
  hideDelay?: number;
  /** Minimum gap from the viewport edge, in px. */
  margin?: number;
}

export interface LinkPreviewState<T> {
  /** The resolved preview, or null when no card should render. */
  preview: T | null;
  /** Spread onto your card element: position, and the keep-open handlers. */
  cardProps: {
    style: CSSProperties;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
}

/**
 * Wikipedia-style hover cards over a rendered article.
 *
 * One delegated listener on `document` rather than a component per link, which
 * is what makes this viable over an article holding hundreds of anchors. Two
 * wikis had written the same ~90 lines: the same 350ms intent delay, the same
 * 200ms grace so the cursor can cross the gap into the card, the same
 * viewport-clamp arithmetic, the same per-href cache. They differed in exactly
 * three things, and those three are the options above.
 */
export function useLinkPreview<T>({
  eligible,
  fetch,
  cardClassName = 'link-preview-card',
  cardWidth = 320,
  cardHeight = 240,
  showDelay = 350,
  hideDelay = 200,
  margin = 8,
}: LinkPreviewOptions<T>): LinkPreviewState<T> {
  const [card, setCard] = useState<{ data: T; left: number; top: number; above: boolean } | null>(
    null,
  );
  const cache = useRef(new Map<string, T | null>());
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeHref = useRef<string | null>(null);

  // The handlers below are rebuilt whenever these change, so they are read from
  // a ref instead — a caller passing an inline `eligible` arrow would otherwise
  // tear down and rebind the document listeners on every render.
  const opts = useRef({ eligible, fetch });
  opts.current = { eligible, fetch };

  const hide = useCallback(() => {
    hideTimer.current = setTimeout(() => {
      activeHref.current = null;
      setCard(null);
    }, hideDelay);
  }, [hideDelay]);

  useEffect(() => {
    const clearTimers = () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    };

    const onOver = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest('a') as HTMLAnchorElement | null;
      if (!anchor || !opts.current.eligible(anchor)) return;
      const href = (anchor.getAttribute('href') ?? '').replace(/[#?].*$/, '');
      if (!href) return;
      // Re-entering the link the card is already for: cancel the pending hide
      // rather than refetching and re-placing an identical card.
      if (activeHref.current === href) {
        clearTimeout(hideTimer.current);
        return;
      }
      clearTimers();
      activeHref.current = href;

      showTimer.current = setTimeout(async () => {
        let data = cache.current.get(href);
        if (data === undefined) {
          try {
            data = await opts.current.fetch(href);
          } catch {
            data = null;
          }
          cache.current.set(href, data);
        }
        // The cursor may have moved on during the fetch.
        if (activeHref.current !== href || data === null) return;
        const rect = anchor.getBoundingClientRect();
        const above = rect.bottom + cardHeight > window.innerHeight && rect.top > cardHeight;
        setCard({
          data,
          left: Math.max(margin, Math.min(rect.left, window.innerWidth - cardWidth - margin)),
          top: above ? rect.top - margin : rect.bottom + margin,
          above,
        });
      }, showDelay);
    };

    const onOut = (e: MouseEvent) => {
      // Moving into the card itself is not leaving.
      if ((e.relatedTarget as HTMLElement | null)?.closest(`.${cardClassName}`)) return;
      clearTimers();
      hide();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    return () => {
      clearTimers();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
    };
  }, [cardClassName, cardWidth, cardHeight, showDelay, margin, hide]);

  return {
    preview: card?.data ?? null,
    cardProps: {
      style: {
        left: card?.left,
        top: card?.top,
        transform: card?.above ? 'translateY(-100%)' : undefined,
      },
      onMouseEnter: () => clearTimeout(hideTimer.current),
      onMouseLeave: hide,
    },
  };
}

// ---- table sort -------------------------------------------------------------

export type SortDirection = 'asc' | 'desc';

export interface TableSortState<T, K extends string> {
  sorted: T[];
  sortKey: K;
  direction: SortDirection;
  /** Spread onto a header cell. `active` is what drives `aria-sort`. */
  headerProps: (key: K) => {
    sortKey: K;
    active: boolean;
    direction: SortDirection;
    onSort: (key: K) => void;
    'aria-sort': 'ascending' | 'descending' | 'none';
  };
  toggle: (key: K) => void;
}

/**
 * One active column, direction toggling on re-click, every table the same.
 *
 * One repo had this as a hook; the other inlined the identical state machine in
 * two chart tables, differing only in the `useState` seed and the comparator
 * payload. The comparator record replaces the `if`-chain those copies used, so
 * adding a column is a map entry rather than another branch.
 *
 * `aria-sort` is emitted here because only one of the two header components had
 * it, and a sortable column that never announces its direction is a button whose
 * effect a screen reader cannot observe.
 */
export function useTableSort<T, K extends string>(
  rows: readonly T[],
  config: { defaultKey: K; comparators: Record<K, (a: T, b: T) => number>; defaultDirection?: SortDirection },
): TableSortState<T, K> {
  const { defaultKey, comparators, defaultDirection = 'desc' } = config;
  const [sortKey, setSortKey] = useState<K>(defaultKey);
  const [direction, setDirection] = useState<SortDirection>(defaultDirection);

  const toggle = useCallback(
    (key: K) => {
      if (key === sortKey) setDirection(d => (d === 'desc' ? 'asc' : 'desc'));
      else {
        setSortKey(key);
        setDirection(defaultDirection);
      }
    },
    [sortKey, defaultDirection],
  );

  const sorted = useMemo(() => {
    const comparator = comparators[sortKey];
    if (!comparator) return [...rows];
    const multiplier = direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => multiplier * comparator(a, b));
  }, [rows, sortKey, direction, comparators]);

  const headerProps = useCallback(
    (key: K) => {
      const active = key === sortKey;
      return {
        sortKey: key,
        active,
        direction,
        onSort: toggle,
        'aria-sort': (active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none') as
          | 'ascending'
          | 'descending'
          | 'none',
      };
    },
    [sortKey, direction, toggle],
  );

  return { sorted, sortKey, direction, headerProps, toggle };
}

// ---- copy to clipboard ------------------------------------------------------

/**
 * "Copied", then not, after a beat. Six call sites across three repos wrote the
 * same three statements, and four of the six had no rejection handler — so a
 * denied clipboard permission left the button claiming success. The imperative
 * twin in `wiki-formant/dom` has handled that since it was extracted.
 *
 * The key form is for a surface with several copyable things and one indicator:
 * `copied === 'cite'` rather than a boolean per button.
 */
export function useCopy<K extends string = string>(revertAfter = 2000): {
  copied: K | null;
  copy: (text: string, key?: K) => Promise<boolean>;
} {
  const [copied, setCopied] = useState<K | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A component unmounted inside the revert window would otherwise set state on
  // a dead tree.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(
    async (text: string, key?: K) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopied((key ?? 'copied') as K);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), revertAfter);
      return true;
    },
    [revertAfter],
  );

  return { copied, copy };
}

// ---- error boundary ---------------------------------------------------------

/**
 * The one thing hooks cannot express, so it is worth owning once.
 *
 * `fallback` is a render prop taking a `retry` closure, which is the better of
 * the two shapes this was lifted from: the other hardcoded its own "Try again"
 * button and so could not be restyled or relabelled by a caller. Recovery is the
 * caller's, and the boundary only decides when to offer it.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (retry: () => void) => ReactNode; onError?: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError?.(error);
  }

  render() {
    if (this.state.failed) return this.props.fallback(() => this.setState({ failed: false }));
    return this.props.children;
  }
}
