import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { compact, addBacklog, render, ident, scopeSql, staleWrite } from '../dist/maintenance.js';

test('compact keeps open work items, pinned flags first, newest next, and caps the rest', () => {
  const backlog = [
    'old item',
    { date: '2026-10-01', item: 'run 214 (ecosystem): link audit CLEAN' },
    { date: '2026-10-02', item: 'done thing', status: 'done' },
    { date: '2026-01-01', item: 'FLAG FOR A HUMAN: add a sitemap' },
    { date: '2026-10-03', item: 'newest' },
    ...Array.from({ length: 70 }, (_, i) => ({ date: '2026-09-01', item: `filler ${i}` })),
  ];
  const out = compact({ backlog, runHistory: Array.from({ length: 40 }, (_, i) => ({ date: String(i) })) });
  assert.equal(out.backlog.length, 60);
  assert.deepEqual(out.backlog.slice(0, 2).map(b => b.item), ['FLAG FOR A HUMAN: add a sitemap', 'newest']);
  assert.ok(!out.backlog.some(b => /^run \d|done thing/.test(b.item)));
  assert.equal(out.runHistory.length, 30);
  assert.equal(out.runHistory.at(-1).date, '39', 'the newest runs are the ones kept');
});

test('flags are capped at what the page shows, the newest kept, and work items fill behind them', () => {
  const flags = Array.from({ length: 20 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, item: `FLAG FOR A HUMAN: ${i}` }));
  const out = compact({ backlog: [...flags, 'work'] });
  assert.equal(out.backlog.length, 16);
  assert.equal(out.backlog[0].item, 'FLAG FOR A HUMAN: 19');
  assert.equal(out.backlog[14].item, 'FLAG FOR A HUMAN: 5');
  assert.equal(out.backlog[15].item, 'work');
});

test('a write that would lose a later run is refused', () => {
  assert.match(staleWrite({ totalRuns: 459 }, { totalRuns: 458 }), /totalRuns 458 over the stored 459/);
  assert.match(staleWrite({ totalRuns: 3 }, {}), /totalRuns 0/);
  assert.equal(staleWrite({ totalRuns: 459 }, { totalRuns: 459 }), null);
  assert.equal(staleWrite({}, { totalRuns: 1 }), null);
});

test('compact ages out untouched sources, never banked verdicts', () => {
  const sources = Object.fromEntries(Array.from({ length: 160 }, (_, i) => [`site${i}`, { lastChecked: `2026-09-${String(i % 28 + 1).padStart(2, '0')}` }]));
  sources.wall = { lastChecked: '2020-01-01', note: 'bot wall, banked' };
  const out = compact({ sources });
  assert.equal(Object.keys(out.sources).length, 151);
  assert.ok(out.sources.wall);
});

test('addBacklog dedupes against what is there and dates what it adds', () => {
  const added = addBacklog({ backlog: ['a', { item: 'b' }] }, ['a', { item: 'b' }, 'c', { item: 'd', date: '2026-01-01' }, 'c'], '2026-10-14');
  assert.deepEqual(added, [
    { date: '2026-10-14', item: 'c', status: 'open' },
    { date: '2026-01-01', item: 'd', status: 'open' },
  ]);
});

test('render escapes state, names the routine, links a tweet URL and says what it held back', () => {
  let n = 0;
  const blocks = render({
    totalRuns: 3,
    mission: 'be <b>good</b>',
    backlog: Array.from({ length: 20 }, (_, i) => `item ${i} <script>`),
    sources: { x: { lastChecked: '2026-10-01', note: 'n', list: ['@a', { handle: '@b' }] } },
    runHistory: [{ date: 'd', category: 'c', summary: 's', tweet: 'https://x.com/i/1' }],
  }, 'wiki-sweep', () => `id${n++}`);
  const html = blocks.map(b => b.text).join('');
  assert.equal(blocks.length, 6);
  assert.deepEqual(blocks.map(b => b.id), ['id0', 'id1', 'id2', 'id3', 'id4', 'id5']);
  assert.match(html, /<code>wiki-sweep<\/code>/);
  assert.match(html, /be &lt;b&gt;good&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /5 older open items held in state/);
  assert.match(html, /watching: @a, @b/);
  assert.match(html, /<a href="https:\/\/x\.com\/i\/1">link<\/a>/);
});

test('table and column names are identifiers or nothing', () => {
  assert.equal(ident('wiki_pages', 't'), '"wiki_pages"');
  assert.throws(() => ident('pages; drop table x', '--table'), /--table/);
  assert.throws(() => ident(undefined, '--pages'), /--pages/);
  assert.deepEqual(scopeSql(undefined, 3), { sql: 'TRUE', values: [] });
  assert.deepEqual(scopeSql('caper_id', 3), { sql: '"caper_id" IS NULL', values: [] });
  assert.deepEqual(scopeSql('caper_id=12', 3), { sql: '"caper_id" = $3', values: ['12'] });
});

test('the bins refuse an incomplete command before touching a database', () => {
  const run = (bin, ...a) => {
    try {
      execFileSync('node', [new URL(`../bin/${bin}.mjs`, import.meta.url).pathname, ...a], { stdio: 'pipe', env: { PATH: process.env.PATH } });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run('maintenance-log', 'read'), 2, 'no --at or --routine');
  assert.equal(run('maintenance-log', 'erase', '--at', 'a/b', '--routine', 'r'), 2);
  assert.equal(run('mark-verified', 'contents'), 2, 'a slug or --all is required');
});
