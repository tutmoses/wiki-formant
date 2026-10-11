import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// A browser for the editor and for mounting the hooks: the address field's
// commands run on a real Tiptap editor, and the leave guard and ⌘S listen on
// a real window.
const { window } = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
Object.assign(globalThis, {
  window,
  document: window.document,
  getComputedStyle: window.getComputedStyle,
  requestAnimationFrame: cb => setTimeout(cb, 0),
  cancelAnimationFrame: id => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { Editor } = await import('@tiptap/core');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { applyUrlPrompt, useUrlPrompt, wikiLink } = await import('wiki-formant/editor');
const { useUnsavedChanges, useSaveShortcut } = await import('wiki-formant/react');

const noMaps = { resolveMapUrl: async () => null };
const editorWith = html => new Editor({ extensions: [StarterKit, wikiLink], content: html });
// The cursor inside the link, collapsed: where it is when an author clicks a link to change it.
const caretIn = (editor, text) => {
  let at = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text.includes(text)) at = pos + node.text.indexOf(text) + 1;
  });
  editor.commands.setTextSelection(at);
};

test('a link field relinks the whole link from a caret inside it', () => {
  const editor = editorWith('<p>See <a href="/old">the guide</a> first.</p>');
  caretIn(editor, 'guide');
  applyUrlPrompt(editor, 'link', '  /new  ', noMaps);
  assert.equal(editor.getHTML(), '<p>See <a class="link" href="/new">the guide</a> first.</p>');
  editor.destroy();
});

test('an emptied link field unlinks and keeps the text', () => {
  const editor = editorWith('<p>See <a href="/old">the guide</a> first.</p>');
  caretIn(editor, 'guide');
  applyUrlPrompt(editor, 'link', '', noMaps);
  assert.equal(editor.getHTML(), '<p>See the guide first.</p>');
  editor.destroy();
});

test('an embed field with no address inserts nothing', () => {
  const editor = editorWith('<p>Text</p>');
  applyUrlPrompt(editor, 'embed', '   ', noMaps);
  assert.equal(editor.getHTML(), '<p>Text</p>');
  editor.destroy();
});

// Mount a component that hands the hook's return value out through `out`.
function mount(render) {
  const root = createRoot(document.getElementById('root'));
  const out = {};
  const Probe = props => {
    Object.assign(out, render(props));
    return null;
  };
  const rerender = props => act(() => root.render(createElement(Probe, props)));
  return { out, rerender, unmount: () => act(() => root.unmount()) };
}

test('the address field opens on the link under the caret, and toggles shut', () => {
  const editor = editorWith('<p>See <a href="/old">the guide</a>.</p>');
  caretIn(editor, 'guide');
  const { out, rerender, unmount } = mount(({ editor }) => useUrlPrompt(editor, noMaps));
  rerender({ editor });
  act(() => out.toggle('link'));
  assert.equal(out.kind, 'link');
  assert.equal(out.value, '/old');
  act(() => out.toggle('link'));
  assert.equal(out.kind, null);
  act(() => out.toggle('embed'));
  assert.equal(out.value, '');
  // A toolbar that moves to another block's editor drops the open field.
  rerender({ editor: editorWith('<p>Other</p>') });
  assert.equal(out.kind, null);
  unmount();
  editor.destroy();
});

test('Enter in the address field applies it and closes the field', () => {
  const editor = editorWith('<p>See <a href="/old">the guide</a>.</p>');
  caretIn(editor, 'guide');
  const { out, rerender, unmount } = mount(({ editor }) => useUrlPrompt(editor, noMaps));
  rerender({ editor });
  act(() => out.toggle('link'));
  act(() => out.setValue('/new'));
  let prevented = false;
  act(() => out.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; } }));
  assert.ok(prevented);
  assert.equal(out.kind, null);
  assert.match(editor.getHTML(), /href="\/new"/);
  unmount();
  editor.destroy();
});

test('unsaved changes hold a reload and ask before an in-app exit', () => {
  const asked = [];
  window.confirm = message => (asked.push(message), false);
  const { out, rerender, unmount } = mount(({ dirty }) => ({ confirmLeave: useUnsavedChanges(dirty) }));
  const unload = () => {
    const e = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  rerender({ dirty: false });
  assert.equal(unload(), false);
  assert.equal(out.confirmLeave(), true);
  assert.equal(asked.length, 0);

  rerender({ dirty: true });
  assert.equal(unload(), true);
  assert.equal(out.confirmLeave(), false);
  assert.deepEqual(asked, ['Leave without saving your changes?']);

  rerender({ dirty: false });
  assert.equal(unload(), false);
  unmount();
});

test('⌘S and Ctrl+S save with the latest callback, and nothing else does', () => {
  const saves = [];
  const { rerender, unmount } = mount(({ n }) => useSaveShortcut(() => saves.push(n)));
  const press = init => {
    const e = new window.KeyboardEvent('keydown', { cancelable: true, ...init });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  rerender({ n: 1 });
  assert.equal(press({ key: 's', metaKey: true }), true);
  rerender({ n: 2 });
  assert.equal(press({ key: 'S', ctrlKey: true }), true);
  assert.equal(press({ key: 's' }), false);
  assert.equal(press({ key: 'a', metaKey: true }), false);
  assert.deepEqual(saves, [1, 2]);
  unmount();
  assert.equal(press({ key: 's', metaKey: true }), false);
});
