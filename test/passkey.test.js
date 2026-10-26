import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPasskeyGate } from 'wiki-formant/passkey';
import { Stats, statsDays, statsQuery } from 'wiki-formant/stats';

// Just enough of PasskeyToken to follow a token through its life. Expiry is
// the row's own `ttl` against a clock the test can move. `passkeys` holds the
// ids of the saved passkeys.
function fakeDb(saved = 1) {
  const rows = new Map();
  const passkeys = new Set(saved ? ['pk'] : []);
  let now = 0;
  const sql = async (query, ...v) => {
    if (query.startsWith('DELETE FROM "PasskeyToken" WHERE "expiresAt"')) {
      for (const [h, r] of rows) if (r.expires < now) rows.delete(h);
      return [];
    }
    if (query.startsWith('INSERT INTO "PasskeyToken"')) {
      rows.set(v[0], { kind: v[1], expires: now + v[2], passkeyId: v[3] });
      return [];
    }
    if (query.startsWith('DELETE FROM "PasskeyToken" WHERE hash')) {
      const r = rows.get(v[0]);
      if (!r || r.kind !== v[1]) return [];
      rows.delete(v[0]);
      return [{ live: r.expires > now }];
    }
    if (query.startsWith('SELECT 1 FROM "PasskeyToken" t JOIN "Passkey"')) {
      const r = rows.get(v[0]);
      return r && r.kind === 'session' && r.expires > now && passkeys.has(r.passkeyId) ? [{}] : [];
    }
    if (query.startsWith('SELECT 1 FROM "PasskeyToken"')) {
      const r = rows.get(v[0]);
      return r && r.kind === v[1] && r.expires > now ? [{}] : [];
    }
    if (query.startsWith('SELECT id')) return [];
    throw new Error(`unexpected: ${query}`);
  };
  return { sql, rows, passkeys, tick: s => (now += s) };
}

const sha = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');

const post = (body, ip = '203.0.113.1') =>
  new Request('https://site.test/api/passkey', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

test('a token is stored only as its hash, and an invite is a different kind from a session', async () => {
  const db = fakeDb();
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  const invite = await gate.invite();
  assert.equal(db.rows.size, 1);
  assert.ok(!db.rows.has(invite));
  assert.equal(await gate.signedIn(invite), false);
  assert.equal(await gate.signedIn(undefined), false);
});

test('an invite asks the browser to save a passkey; no invite asks it to sign in', async () => {
  const db = fakeDb();
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  const invite = await gate.invite();

  const save = await (await gate.route(post({ invite }))).json();
  assert.equal(save.rp.id, 'site.test');
  assert.equal(save.authenticatorSelection.residentKey, 'required');

  const signIn = await (await gate.route(post({}, '203.0.113.2'))).json();
  assert.equal(signIn.rpId, 'site.test');
  assert.equal(signIn.user, undefined);
  // Both challenges and the invite are rows; none is spent by asking.
  assert.equal(db.rows.size, 3);
});

test('an expired or unknown invite is refused before any prompt', async () => {
  const db = fakeDb();
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  const invite = await gate.invite(1);
  db.tick(86_401);
  assert.equal((await gate.route(post({ invite }, '203.0.113.3'))).status, 403);
  assert.equal((await gate.route(post({ invite: 'nope' }, '203.0.113.3'))).status, 403);
});

test('a response nobody issued a challenge for is refused, and sets no cookie', async () => {
  const db = fakeDb();
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  const res = await gate.route(post({ response: { id: 'abc', rawId: 'abc', type: 'public-key', response: {} } }, '203.0.113.4'));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('a site with no passkey asks the browser to sign in, and saves none without an invite', async () => {
  const db = fakeDb(0);
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  const signIn = await (await gate.route(post({}, '203.0.113.5'))).json();
  assert.equal(signIn.rp, undefined);
  assert.equal(signIn.rpId, 'site.test');
  const res = await gate.route(post({ response: { id: 'abc', rawId: 'abc', type: 'public-key', response: {} } }, '203.0.113.5'));
  assert.equal(res.status, 403);
  assert.equal(db.passkeys.size, 0);
});

test('a challenge is kept as the ceremony it was issued for', async () => {
  const db = fakeDb();
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  const invite = await gate.invite();
  await gate.route(post({ invite }, '203.0.113.6'));
  await gate.route(post({}, '203.0.113.6'));
  assert.deepEqual([...db.rows.values()].map(r => r.kind).sort(), ['authentication', 'invite', 'registration']);
});

test('a session lives only as long as its passkey, and signing out ends it', async () => {
  const db = fakeDb();
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  db.rows.set(await sha('s1'), { kind: 'session', expires: 1000, passkeyId: 'pk' });
  db.rows.set(await sha('s2'), { kind: 'session', expires: 1000, passkeyId: null });
  assert.equal(await gate.signedIn('s1'), true);
  assert.equal(await gate.signedIn('s2'), false, 'a session bound to no passkey is not one');
  db.passkeys.delete('pk');
  assert.equal(await gate.signedIn('s1'), false);

  db.passkeys.add('pk');
  const out = await gate.signOut(new Request('https://site.test/api/passkey', { method: 'DELETE', headers: { cookie: `a=b; ${gate.cookie}=s1` } }));
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /^passkey_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/);
  assert.equal(await gate.signedIn('s1'), false);
});

const DIGEST = {
  visitors: 12, pageviews: 30, bounce_rate: 50, visit_duration: 75, agents: 3, visitors_incl_agents: 15,
  previous: { visitors: 10, pageviews: 30, bounce_rate: 46, visit_duration: 100, agents: null, visitors_incl_agents: 10, follow_clicks: null },
  top_sources: [{ source: 'x', visitors: 4 }], top_pages: [{ page: '/', visitors: 9 }, { page: '/a', visitors: 3 }],
  entry_pages: [], from_posts: [], sibling_referrals: [], countries: [{ country: 'GB', visitors: 5 }],
  devices: [{ device: 'phone', visitors: 7 }], by_day: [], follow_clicks: null,
  top_agents: [{ agent: 'ClaudeBot', visitors: 2 }, { agent: 'node', visitors: 1 }], agent_tool_calls: [], gaps: [],
  counted_from: '2026-10-01',
};

test('the stats page leaves out empty lists and marks the window shown', () => {
  const out = renderToStaticMarkup(createElement(Stats, { digest: DIGEST, days: 7 }));
  assert.match(out, /<div class="chart-controls"><div role="group" aria-label="Window"><a href="\?days=1">24H<\/a><a href="\?days=7" aria-current="page">7D<\/a>/);
  // Visitors count agents, unless the page is asked to keep them apart.
  assert.match(out, /<div class="stats-figures" role="group" aria-label="Chart"><button type="button" aria-pressed="true"><span>Visitors<\/span><strong>15<small class="stats-delta" data-better="true">\+50%<\/small><\/strong><\/button><button type="button" aria-pressed="false"><span>Page views/);
  assert.match(out, /<span>Page views<\/span><strong>30<small class="stats-delta">0%<\/small><\/strong>/);
  assert.match(out, /<span>Bounce rate<\/span><strong>50%<small class="stats-delta" data-better="false">\+4 pp<\/small><\/strong>/);
  assert.match(out, /<span>Visit length<\/span><strong>1m 15s<small class="stats-delta" data-better="false">-25%<\/small><\/strong>/);
  // Agents are named in a list that narrows nothing.
  assert.match(out, /<h2>Agents<\/h2><ol><li style="--share:1"><span>ClaudeBot<\/span>/);
  assert.match(out, /aria-pressed="false"><span>Bounce rate<\/span>/);
  assert.match(out, /1m 15s/);
  assert.match(out, /United Kingdom/);
  assert.match(out, /--share:0\.3333/);
  assert.doesNotMatch(out, /Entry pages|Clicks to X/);
  assert.match(out, /<figure class="chart stats-chart"><div class="chart-canvas" role="img" aria-label="Visitors"><\/div>/);
  // The agents switch follows the windows, the steps follow them, and a week of days makes only one week.
  assert.match(out, /<a href="\?days=all">All<\/a><\/div><div><a href="\?days=7&amp;agents=apart" role="switch" aria-checked="false" title="People and agents counted apart">Agents apart<\/a><\/div><div role="group" aria-label="Step"><button type="button" aria-pressed="true" title="One point per day">D<\/button><button type="button" aria-pressed="false" disabled="" title="One point per week">W<\/button><button type="button" aria-pressed="false" disabled="" title="One point per month">M<\/button><\/div><\/div><\/figure>/);
});

test('apart, people and agents are two figures, and every link but the switch keeps them apart', () => {
  const out = renderToStaticMarkup(createElement(Stats, { digest: DIGEST, days: 7, apart: true, filter: { device: 'phone' } }));
  assert.match(out, /<button type="button" aria-pressed="true"><span>People<\/span><strong>12<small class="stats-delta" data-better="true">\+20%<\/small><\/strong><\/button><button type="button" aria-pressed="false"><span>Agents<\/span><strong>3<\/strong><\/button>/);
  assert.doesNotMatch(out, /<span>Visitors<\/span>/);
  assert.match(out, /<a href="\?days=90&amp;agents=apart&amp;device=phone">90D<\/a>/);
  assert.match(out, /<a href="\?days=7&amp;agents=apart&amp;country=GB&amp;device=phone">United Kingdom<\/a>/);
  assert.match(out, /<a href="\?days=7&amp;agents=apart" title="Remove">Device: phone ×<\/a>/);
  assert.match(out, /<a href="\?days=7&amp;device=phone" role="switch" aria-checked="true" title="People and agents counted apart">Agents apart<\/a>/);
});

test('no change from the window before is unsigned', () => {
  const out = renderToStaticMarkup(createElement(Stats, { digest: { ...DIGEST, previous: { ...DIGEST.previous, visitors_incl_agents: 15 } }, days: 1 }));
  assert.match(out, /<strong>15<small class="stats-delta">0%<\/small>/);
});

test('every row narrows the page to itself, and keeps the window and what is already narrowed', () => {
  const out = renderToStaticMarkup(createElement(Stats, { digest: DIGEST, days: 7, filter: { device: 'phone' } }));
  assert.match(out, /<a href="\?days=7&amp;page=%2Fa&amp;device=phone">\/a<\/a>/);
  assert.match(out, /<a href="\?days=7&amp;country=GB&amp;device=phone">United Kingdom<\/a>/);
  assert.match(out, /<a href="\?days=90&amp;device=phone">90D<\/a>/);
  assert.match(out, /<a href="\?days=7" title="Remove">Device: phone ×<\/a>/);
  assert.doesNotMatch(out, /Narrowed figures start/);
  const month = renderToStaticMarkup(createElement(Stats, { digest: { ...DIGEST, counted_from: new Date().toISOString().slice(0, 10) }, days: 30, filter: { device: 'phone' } }));
  assert.match(month, /Narrowed figures start on \d{4}-\d\d-\d\d, the first day/);
});

test('a narrowed page has no comparison with the window before', () => {
  const out = renderToStaticMarkup(createElement(Stats, { digest: { ...DIGEST, previous: { ...DIGEST.previous, visitors_incl_agents: null } }, days: 7, filter: { page: '/' } }));
  assert.match(out, /<strong>15<\/strong>/);
});

test('the query reads the window and one value per filter', () => {
  assert.deepEqual(statsQuery({ days: '90', page: '/a', country: ['GB', 'FR'], device: '', other: 'x' }), { days: 90, filter: { page: '/a' }, apart: false });
  assert.equal(statsQuery({ agents: 'apart' }).apart, true);
});

test('a ?days= value outside the offered windows falls back', () => {
  assert.equal(statsDays('7'), 7);
  assert.equal(statsDays(['7']), 30);
  assert.equal(statsDays('3'), 30);
  assert.equal(statsDays(undefined), 30);
});
