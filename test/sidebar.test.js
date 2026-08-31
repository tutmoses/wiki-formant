import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSidebarOpen } from '../dist/sidebar.js';

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
