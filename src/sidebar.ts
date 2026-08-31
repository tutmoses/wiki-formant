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
