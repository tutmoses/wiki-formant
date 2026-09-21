import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  railBreakpointMismatch,
  RAIL_FLOATING_PROPERTY,
  resolveSidebarOpen,
} from 'wiki-formant/sidebar';
import { isRailLinkActive } from 'wiki-formant/react';

// The collapse rule carries both bug fixes, so it is tested directly. The
// component around it is verified in a browser, where a DOM actually exists.

test('with nothing remembered, the viewport decides', () => {
  assert.equal(resolveSidebarOpen({ chosen: false, current: true, stored: null, isMobile: false }), true);
  assert.equal(resolveSidebarOpen({ chosen: false, current: true, stored: null, isMobile: true }), false);
});

test('a remembered choice outranks the viewport', () => {
  // Collapsed on a laptop, then opened on a phone-width window: still collapsed.
  assert.equal(resolveSidebarOpen({ chosen: false, current: true, stored: false, isMobile: false }), false);
  // And the converse: deliberately open, on a narrow screen.
  assert.equal(resolveSidebarOpen({ chosen: false, current: false, stored: true, isMobile: true }), true);
});

test('BUG 1: resizing across the breakpoint cannot discard a choice just made', () => {
  // The old code was `setOpen(!isMobile)` on every matchMedia change, so
  // dragging a window narrow and wide again silently reopened a closed rail.
  const afterCollapse = { chosen: true, current: false, stored: false };
  assert.equal(resolveSidebarOpen({ ...afterCollapse, isMobile: true }), false);
  assert.equal(resolveSidebarOpen({ ...afterCollapse, isMobile: false }), false);
});

test('a choice outranks even a contradicting stored value', () => {
  // Storage is written by the same action that sets `chosen`, so this is only
  // reachable mid-write — but the precedence should still be unambiguous.
  assert.equal(resolveSidebarOpen({ chosen: true, current: false, stored: true, isMobile: false }), false);
});

test('the rule is total — every combination returns a boolean', () => {
  for (const chosen of [true, false])
    for (const current of [true, false])
      for (const stored of [true, false, null])
        for (const isMobile of [true, false])
          assert.equal(typeof resolveSidebarOpen({ chosen, current, stored, isMobile }), 'boolean');
});

test('BUG 2: the first paint is open, so a desktop load never flashes shut', () => {
  // The initial state feeding the rule on the server and first client paint is
  // `current: true` with nothing chosen and nothing read yet.
  assert.equal(resolveSidebarOpen({ chosen: false, current: true, stored: null, isMobile: false }), true);
});

// ---- rail link activity -----------------------------------------------------

test('a section stays lit while you read a page inside it', () => {
  assert.equal(isRailLinkActive('/wiki/tech', '/wiki/tech', true), true);
  assert.equal(isRailLinkActive('/wiki/tech/core-concepts', '/wiki/tech', true), true);
  assert.equal(isRailLinkActive('/wiki/tech/core-concepts', '/wiki/tech', false), false);
  // A sibling whose name merely starts the same is not a descendant.
  assert.equal(isRailLinkActive('/wiki/technology', '/wiki/tech', true), false);
});

test("BUG: a catch-all's prerender arrives percent-encoded", () => {
  // What Next serves for /wiki/tech/core-concepts: the joined segments encoded.
  // Both wikis rendered every page below the top level with nothing lit.
  assert.equal(isRailLinkActive('/wiki/tech%2Fcore-concepts', '/wiki/tech', true), true);
  assert.equal(isRailLinkActive('/wiki/tech%2Fcore-concepts', '/wiki/tech%2Fcore-concepts', false), false);
  assert.equal(isRailLinkActive('/wiki/tech%2Fcore-concepts', '/wiki/tech/core-concepts', false), true);
});

test('a path that will not decode answers for itself', () => {
  assert.equal(isRailLinkActive('/wiki/100%', '/wiki/100%', false), true);
  assert.equal(isRailLinkActive('/wiki/100%/notes', '/wiki/100%', true), true);
});

// ---- rail breakpoint agreement ----------------------------------------------

// The breakpoint is necessarily known twice — matchMedia here, a media query in
// the stylesheet — because neither language can read the other's copy. The rule
// below cannot merge them; it makes them unable to part in silence.

test('agreement is silent, in both states', () => {
  const bp = { breakpoint: 768 };
  assert.equal(railBreakpointMismatch({ ...bp, isMobile: true, floating: true }), null);
  assert.equal(railBreakpointMismatch({ ...bp, isMobile: false, floating: false }), null);
});

test('a stylesheet that has not opted in is not a mismatch', () => {
  // `null` is "the property is not declared" — a consumer using its own
  // mechanism, or a test with no CSSOM. Not knowing must not read as knowing.
  assert.equal(railBreakpointMismatch({ breakpoint: 768, isMobile: true, floating: null }), null);
  assert.equal(railBreakpointMismatch({ breakpoint: 768, isMobile: false, floating: null }), null);
});

test('disagreement names both sides and the number to fix', () => {
  // The case this exists for: CSS floats the rail at one width, JS at another,
  // so between them the rail closes on navigate while still a column.
  const msg = railBreakpointMismatch({ breakpoint: 900, isMobile: false, floating: true });
  assert.ok(msg, 'a disagreement must be reported');
  assert.match(msg, /breakpoint=900/);
  assert.match(msg, /max-width: 899px/);
  assert.ok(msg.includes(RAIL_FLOATING_PROPERTY));
  // And the converse direction is reported too, not just one of them.
  assert.ok(railBreakpointMismatch({ breakpoint: 900, isMobile: true, floating: false }));
});
