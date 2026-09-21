// sidebar.ts — the framework-free half of the collapsible wiki rail.
//
// Separate from `react.tsx` because that file carries `'use client'`, which
// makes every one of its exports a client reference — and `sidebarBootScript`
// has to be callable from a server component to reach the document head.
// Splitting it also lets the collapse rule be tested without a DOM.

/**
 * Whether the rail should be open, given what is known.
 *
 * The whole of both bug fixes lives in these three lines, so it is a named
 * function with tests rather than a condition buried in an effect:
 *
 *   - a choice the reader has made outranks everything, forever;
 *   - a remembered choice outranks the viewport;
 *   - the viewport is consulted only when nothing else has an opinion.
 */
export function resolveSidebarOpen({
  chosen,
  current,
  stored,
  isMobile,
}: {
  /** Has the reader touched the control this session? */
  chosen: boolean;
  /** What the rail is showing now. */
  current: boolean;
  /** What storage remembers, or null if it has never been written. */
  stored: boolean | null;
  /** Is the viewport below the breakpoint? */
  isMobile: boolean;
}): boolean {
  if (chosen) return current;
  return stored ?? !isMobile;
}

/** The attribute the boot script and the hook both write to `<html>`. */
export const SIDEBAR_ATTRIBUTE = 'data-sidebar';

/**
 * The custom property a consumer's stylesheet sets inside its own rail media
 * query — `1` where the rail stops being a column beside the article, `0`
 * elsewhere.
 *
 * The rail's breakpoint is necessarily known twice: this hook needs it in JS
 * (to close the rail on navigate, and to default a first-ever visit), and the
 * stylesheet needs it in CSS (to lay the rail out, before any script runs and
 * whether or not one ever does). A media query cannot read a JS constant and a
 * JS constant cannot read a media query, so the two numbers cannot be merged —
 * but they can be made unable to disagree QUIETLY, which is the actual hazard.
 *
 * All three wikis matched by hand and all three happened to be right; nothing
 * said so. Declaring this property is what opts a stylesheet into the check.
 */
export const RAIL_FLOATING_PROPERTY = '--rail-floating';

/**
 * What the stylesheet currently says about the rail: `true` inside the repo's
 * rail media query, `false` outside it, `null` when the property is not
 * declared — a consumer that has not opted in, or a render with no DOM.
 */
export function readRailFloating(): boolean | null {
  if (typeof document === 'undefined') return null;
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(RAIL_FLOATING_PROPERTY)
      .trim();
    return value === '' ? null : value === '1';
  } catch {
    // No CSSOM (jsdom without styles, a blocked stylesheet). Not knowing is not
    // a mismatch, and a diagnostic must never be the thing that breaks a page.
    return null;
  }
}

/**
 * The complaint to make when CSS and JS disagree about where the rail floats,
 * or `null` when they agree or the stylesheet has not opted in.
 *
 * Pure, and separate from the reading, so the rule is testable without a DOM.
 */
export function railBreakpointMismatch({
  isMobile,
  floating,
  breakpoint,
}: {
  /** What `matchMedia` told the hook. */
  isMobile: boolean;
  /** What the stylesheet says, from `readRailFloating()`. */
  floating: boolean | null;
  /** The breakpoint the hook was given, for naming the number in the message. */
  breakpoint: number;
}): string | null {
  if (floating === null || floating === isMobile) return null;
  return (
    `wiki-formant: the rail's breakpoint disagrees between CSS and JS. ` +
    `This hook was given breakpoint=${breakpoint}, so it believes the rail ` +
    `${isMobile ? 'should float' : 'should be a column'} at this width, ` +
    `while ${RAIL_FLOATING_PROPERTY} says it ` +
    `${floating ? 'should float' : 'should be a column'}. ` +
    `Set ${RAIL_FLOATING_PROPERTY}: 1 inside the same media query that lays the ` +
    `rail out, and give that query the edge of breakpoint=${breakpoint} ` +
    `(max-width: ${breakpoint - 1}px).`
  );
}

/**
 * A blocking inline script for the document head, so the rail's first paint
 * already matches what the reader last chose.
 *
 * Server rendering cannot see `localStorage`, so a remembered-closed rail would
 * otherwise paint open and then animate shut on every single load. This is the
 * same trick a theme switcher uses for exactly the same reason. Stamp it with
 * `dangerouslySetInnerHTML` in `<head>`, and style against
 * `html[data-sidebar='closed']` rather than against the React class alone.
 *
 * It is wrapped in try/catch because a browser with site data blocked throws on
 * the read, and a rail that cannot remember is much better than a page that
 * dies before it paints.
 */
export function sidebarBootScript(storageKey = 'wiki:sidebar', breakpoint = 1024): string {
  return (
    `(function(){try{var v=localStorage.getItem(${JSON.stringify(storageKey)});` +
    `var o=v===null?!window.matchMedia("(max-width: ${breakpoint - 1}px)").matches:v==="1";` +
    `document.documentElement.setAttribute(${JSON.stringify(SIDEBAR_ATTRIBUTE)},o?"open":"closed");}catch(e){}})()`
  );
}
