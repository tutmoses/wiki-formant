import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });

const { createElement: h, act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BlockEditor, BlockFieldsKit, CodeTabsFields, ColumnsFields, InfoboxFields, LimitField, LinkGridFields, ListFields, PageListFields, ReferencesFields } = await import('wiki-formant/block-editor');

// A three-type wiki: enough for a container, a single-use type and a leaf.
let n = 0;
const create = type =>
  type === 'columns'
    ? { id: `b${++n}`, type, columns: [{ id: `c${++n}`, blocks: [] }, { id: `c${++n}`, blocks: [] }] }
    : type === 'infobox'
      ? { id: `b${++n}`, type, blocks: [] }
      : type === 'codeTabs'
        ? { id: `b${++n}`, type, tabs: [] }
        : { id: `b${++n}`, type, limit: 5 };
const META = { codeTabs: 'Code tabs', columns: 'Columns', infobox: 'Infobox', recentPages: 'Recent pages' };
const schema = {
  meta: type => (META[type] ? { label: META[type], hint: `${META[type]} hint` } : undefined),
  create,
  duplicate: b => ({ ...b, id: `${b.id}-copy` }),
  renderBody: (block, onUpdate) => {
    switch (block.type) {
      case 'codeTabs': return h(CodeTabsFields, { block, onUpdate, langs: ['rust', 'sql'] });
      case 'columns': return h(ColumnsFields, { block, onUpdate });
      case 'infobox': return h(InfoboxFields, { block, onUpdate });
      case 'recentPages': return h(LimitField, { value: block.limit, onChange: limit => onUpdate({ ...block, limit }) });
      default: return null;
    }
  },
  types: ['codeTabs', 'columns', 'infobox', 'recentPages'],
  nestedTypes: ['codeTabs', 'recentPages'],
  single: ['infobox'],
};
const kit = { classNames: { card: 'card' }, icons: { add: '+', up: '↑', down: '↓', duplicate: '⧉', remove: '×' } };

function mount(initial) {
  const root = createRoot(document.getElementById('root'));
  const state = { blocks: initial };
  function Host() {
    const [blocks, setBlocks] = useState(initial);
    state.blocks = blocks;
    return h(BlockEditor, { blocks, onChange: setBlocks, schema, kit });
  }
  act(() => root.render(h(Host)));
  return { state, unmount: () => act(() => root.unmount()) };
}

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const click = el => act(() => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const type = (el, value) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
const button = label => $$('button').find(b => b.textContent === label || b.getAttribute('aria-label') === label);

test('the foot menu adds a block, and a single-use type leaves the menu once held', () => {
  const { state, unmount } = mount([]);
  assert.match(document.body.textContent, /Nothing here yet/);
  click(button('+Add block'));
  click($$('button').find(b => b.textContent.startsWith('Infobox')));
  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0].type, 'infobox');
  // The page's foot menu, opened again, no longer offers a second infobox.
  const foot = $$('button').filter(b => b.textContent === '+Add block').at(-1);
  click(foot);
  assert.ok(!$$('button').some(b => b.textContent === 'InfoboxInfobox hint'));
  assert.ok($$('button').some(b => b.textContent === 'Code tabsCode tabs hint'));
  unmount();
});

test('a nested list offers only the nested types and edits through its container', () => {
  const { state, unmount } = mount([create('columns')]);
  const firstColumnAdd = $$('button').filter(b => b.textContent === '+Add block')[0];
  click(firstColumnAdd);
  const offered = $$('button').filter(b => / hint$/.test(b.textContent)).map(b => b.textContent);
  assert.deepEqual(offered, ['Code tabsCode tabs hint', 'Recent pagesRecent pages hint']);
  click($$('button').find(b => b.textContent.startsWith('Recent pages')));
  assert.equal(state.blocks[0].columns[0].blocks[0].type, 'recentPages');
  assert.equal(state.blocks[0].columns[1].blocks.length, 0);
  unmount();
});

test('the card being edited is marked, and its actions name the block', () => {
  const { unmount } = mount([create('recentPages'), create('recentPages')]);
  const cards = $$('section.card');
  assert.ok(!cards[1].hasAttribute('data-selected'));
  click(cards[1]);
  assert.ok($$('section.card')[1].hasAttribute('data-selected'));
  const ups = $$('button[aria-label="Move Recent pages up"]');
  assert.deepEqual(ups.map(b => b.disabled), [true, false]);
  unmount();
});

test('a type the build does not know is kept, and says so', () => {
  const { state, unmount } = mount([{ id: 'x', type: 'retired', payload: 1 }]);
  assert.match(document.body.textContent, /retired.*Kept as it is/);
  assert.deepEqual(state.blocks, [{ id: 'x', type: 'retired', payload: 1 }]);
  unmount();
});

test('a count is clamped to the row cap the write path enforces', () => {
  const { state, unmount } = mount([create('recentPages')]);
  const input = $('input[type=number]');
  type(input, '5000');
  assert.equal(state.blocks[0].limit, 100);
  type(input, '2.7');
  assert.equal(state.blocks[0].limit, 2);
  type(input, '');
  assert.equal(state.blocks[0].limit, 1);
  unmount();
});

test('a stored code language outside the list stays selected', () => {
  const block = { id: 'ct', type: 'codeTabs', tabs: [{ label: 'Move', language: 'move', code: 'module m {}' }] };
  const { state, unmount } = mount([block]);
  const select = $('select[aria-label=Language]');
  assert.equal(select.value, 'move');
  assert.deepEqual([...select.options].map(o => o.value), ['move', 'rust', 'sql']);
  click(button('+Add tab'));
  assert.deepEqual(state.blocks[0].tabs[1], { label: '', language: 'rust', code: '' });
  click(button('Remove tab Move'));
  assert.equal(state.blocks[0].tabs.length, 1);
  unmount();
});

// A field editor driven directly: the host card's body is the field, so it
// renders inside the editor's provider as it would in a wiki.
function field(Component, props) {
  const root = createRoot(document.getElementById('root'));
  const state = {};
  function Field() {
    const [block, setBlock] = useState(props.block);
    state.block = block;
    return h(Component, { ...props, block, onUpdate: setBlock });
  }
  const host = { ...schema, renderBody: () => h(Field) };
  act(() => root.render(h(BlockEditor, { blocks: [{ id: 'host', type: 'recentPages' }], onChange: () => {}, schema: host, kit })));
  return { state, unmount: () => act(() => root.unmount()) };
}

test('an emptied optional field is stored as absent, not as an empty string', () => {
  const { state, unmount } = field(ReferencesFields, {
    block: { id: 'r', type: 'references', title: 'Sources', items: [{ id: 'i', text: 'A', url: 'https://a.example' }] },
  });
  type($('input[aria-label=Heading]'), '');
  assert.equal(state.block.title, undefined);
  type($('input[aria-label=Address]'), '');
  assert.equal(state.block.items[0].url, undefined);
  assert.ok(button('Remove reference 1'));
  unmount();
});

test('a page list picks from the pages it is given, and moves them', () => {
  const pages = [
    { id: 'a', title: 'Alpha' },
    { id: 'b', title: 'Beta', detail: 'guides' },
  ];
  const { state, unmount } = field(PageListFields, { block: { id: 'p', type: 'pageList', pageIds: ['a'] }, pages });
  type($('select'), 'b');
  assert.deepEqual(state.block.pageIds, ['a', 'b']);
  assert.match(document.body.textContent, /Beta · guides/);
  click($$('button[aria-label="Move page up"]').at(-1));
  assert.deepEqual(state.block.pageIds, ['b', 'a']);
  unmount();
});

test('a list moves between its sources, keeps a wiki\'s own, and picks its pages', () => {
  const pages = [{ id: 'guides/water', title: 'Watering' }];
  const { state, unmount } = field(ListFields, {
    block: { id: 'l', type: 'list', source: 'newest', count: 5, show: 'links' },
    pages,
    sources: [{ value: 'products', label: 'Products' }],
    children: 'their own fields',
  });
  const [source] = $$('select');
  type(source, 'chosen');
  assert.deepEqual(state.block.pages, []);
  type($$('select').at(-2), 'guides/water');
  assert.deepEqual(state.block.pages, ['guides/water']);
  type($$('select')[0], 'products');
  assert.match(document.body.textContent, /their own fields/);
  unmount();
});

test('without pages, a page list takes a typed id once', () => {
  const { state, unmount } = field(PageListFields, { block: { id: 'p', type: 'pageList', pageIds: ['a'] } });
  const input = $('input[aria-label="Page id"]');
  type(input, 'a');
  click(button('+Add page'));
  assert.deepEqual(state.block.pageIds, ['a']);
  type($('input[aria-label="Page id"]'), 'b');
  click(button('+Add page'));
  assert.deepEqual(state.block.pageIds, ['a', 'b']);
  unmount();
});


test('a core block\'s fields render outside the editor, in the kit\'s style', async () => {
  const root = createRoot(document.getElementById('root'));
  let block = { id: 'g', type: 'linkGrid', groups: [{ id: 'g1', heading: 'Docs', links: [{ label: 'Scrypto', href: '/scrypto' }] }] };
  const Grid = () => {
    const [b, set] = useState(block);
    block = b;
    return h(BlockFieldsKit, { kit: { ...kit, classNames: { input: 'input', add: 'add' } } }, h(LinkGridFields, { block: b, onUpdate: set }));
  };
  await act(async () => root.render(h(Grid)));
  assert.equal(document.querySelectorAll('input.input').length, 5, 'intro, heading, description, and the link\'s two fields');
  const addLink = [...document.querySelectorAll('button.add')].find(b => b.textContent.includes('Add link'));
  await act(async () => addLink.click());
  assert.equal(block.groups[0].links.length, 2);
  await act(async () => root.unmount());
});
