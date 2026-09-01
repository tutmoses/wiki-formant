import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comboboxAria, listId, optionId } from '../dist/combobox.js';

// The hook that calls this is verified in a browser. The arithmetic is here,
// and every test below pins a bug that shipped on one of the five surfaces.

const aria = (over = {}) => comboboxAria({ baseId: 'r1', count: 3, highlight: 0, ...over });

test('the container is a listbox and the rows are options', () => {
  const { listProps, optionProps } = aria();
  assert.equal(listProps.role, 'listbox');
  assert.equal(optionProps(0).role, 'option');
  // BUG: one wiki put `aria-selected` on a plain <button>, which is not a role
  // that takes it; another gave the rows `role="option"` with no listbox above
  // them, so the options had no owner. Neither is expressible here.
  assert.equal(optionProps(0)['aria-selected'], true);
  assert.equal(optionProps(1)['aria-selected'], false);
});

test('the input points at the list it actually controls', () => {
  const { inputProps, listProps } = aria();
  assert.equal(inputProps.role, 'combobox');
  assert.equal(inputProps['aria-autocomplete'], 'list');
  assert.equal(inputProps['aria-controls'], listProps.id);
});

test('BUG: aria-activedescendant is omitted, never a dangling id', () => {
  // An id that resolves to no element is worse than no attribute: the field
  // claims an active option and the reader announces nothing. None of the five
  // surfaces set this at all, so both halves of the rule are new.
  assert.equal(aria({ count: 0 }).inputProps['aria-activedescendant'], undefined);
  assert.equal(aria({ highlight: -1 }).inputProps['aria-activedescendant'], undefined);
  assert.equal(aria({ count: 2, highlight: 5 }).inputProps['aria-activedescendant'], undefined);
  assert.equal(aria({ highlight: 2 }).inputProps['aria-activedescendant'], optionId('r1', undefined, 2));
});

test('an empty list is not expanded', () => {
  assert.equal(aria({ count: 0 }).inputProps['aria-expanded'], false);
  assert.equal(aria({ count: 1 }).inputProps['aria-expanded'], true);
});

test('BUG: two surfaces on one hook cannot share option ids', () => {
  // radix-wiki's header renders a desktop list and a mobile list from a single
  // useTypeahead. One id set across both duplicates every option id in the
  // document, and `aria-activedescendant` then resolves to whichever copy the
  // parser reached first — which is the hidden one exactly half the time.
  const desktop = comboboxAria({ baseId: 'r1', listKey: 'desktop', count: 3, highlight: 1 });
  const mobile = comboboxAria({ baseId: 'r1', listKey: 'mobile', count: 3, highlight: 1 });
  assert.notEqual(desktop.listProps.id, mobile.listProps.id);
  assert.notEqual(desktop.optionProps(1).id, mobile.optionProps(1).id);
  assert.equal(desktop.inputProps['aria-activedescendant'], desktop.optionProps(1).id);
  assert.equal(mobile.inputProps['aria-activedescendant'], mobile.optionProps(1).id);
});

test('ids are addressable from outside, for scroll-into-view', () => {
  assert.equal(listId('r1'), 'r1-list');
  assert.equal(listId('r1', 'mobile'), 'r1-mobile');
  assert.equal(optionId('r1', 'mobile', 2), 'r1-mobile-opt-2');
});

test('BUG: a surface that hides its list is not expanded', () => {
  // The hook knows how many results it holds; only the surface knows whether it
  // is rendering them. A header that closes its dropdown on blur keeps the items
  // — so without this the field claims an expanded list that is not in the
  // document, and points aria-activedescendant at a row that is not there.
  const closed = comboboxAria({ baseId: 'r1', count: 3, highlight: 1, open: false });
  assert.equal(closed.inputProps['aria-expanded'], false);
  assert.equal(closed.inputProps['aria-activedescendant'], undefined);
  // Omitted means "the items decide", which is the common case.
  assert.equal(comboboxAria({ baseId: 'r1', count: 3, highlight: 1 }).inputProps['aria-expanded'], true);
  // And open:true still cannot invent an expansion over an empty list.
  assert.equal(comboboxAria({ baseId: 'r1', count: 0, highlight: 0, open: true }).inputProps['aria-expanded'], false);
});
