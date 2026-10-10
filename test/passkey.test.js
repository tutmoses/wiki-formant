import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPasskeyGate } from 'wiki-formant/passkey';
import { Stats, statsDays } from 'wiki-formant/stats';

// Just enough of PasskeyToken to follow a token through its life. Expiry is
// the row's own `ttl` against a clock the test can move. `saved` is how many
// rows Passkey holds.
function fakeDb(saved = 1) {
  const rows = new Map();
  let now = 0;
  const sql = async (query, ...v) => {
    if (query.startsWith('DELETE FROM "PasskeyToken" WHERE "expiresAt"')) {
      for (const [h, r] of rows) if (r.expires < now) rows.delete(h);
      return [];
    }
    if (query.startsWith('INSERT INTO "PasskeyToken"')) {
      rows.set(v[0], { kind: v[1], expires: now + v[2] });
      return [];
    }
    if (query.startsWith('DELETE FROM "PasskeyToken" WHERE hash')) {
      const r = rows.get(v[0]);
      if (!r || r.kind !== v[1]) return [];
      rows.delete(v[0]);
      return [{ live: r.expires > now }];
    }
    if (query.startsWith('SELECT 1 FROM "PasskeyToken"')) {
      const r = rows.get(v[0]);
      return r && r.kind === v[1] && r.expires > now ? [{}] : [];
    }
    if (query.startsWith('SELECT 1 FROM "Passkey" LIMIT 1')) return saved ? [{}] : [];
    if (query.startsWith('SELECT id')) return [];
    throw new Error(`unexpected: ${query}`);
  };
  return { sql, rows, tick: s => (now += s) };
}

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

test('a site with no passkey asks the browser to save one without an invite', async () => {
  const db = fakeDb(0);
  const gate = createPasskeyGate({ sql: db.sql, rpName: 'Site' });
  assert.equal(await gate.open(), true);
  const save = await (await gate.route(post({}, '203.0.113.5'))).json();
  assert.equal(save.rp.id, 'site.test');
  assert.equal(save.authenticatorSelection.residentKey, 'required');
  assert.equal(await createPasskeyGate({ sql: fakeDb().sql, rpName: 'Site' }).open(), false);
});

const DIGEST = {
  visitors: 12, pageviews: 30, bounce_rate: 50, visit_duration: 75, visitors_incl_agents: 15, previous_visitors: 10,
  top_sources: [{ source: 'x', visitors: 4 }], top_pages: [{ page: '/', visitors: 9 }, { page: '/a', visitors: 3 }],
  entry_pages: [], from_posts: [], sibling_referrals: [], countries: [{ country: 'GB', visitors: 5 }],
  devices: [{ device: 'phone', visitors: 7 }], by_day: [], follow_clicks: null, agent_tool_calls: [], gaps: [],
};

test('the stats page leaves out empty lists and marks the window shown', () => {
  const out = renderToStaticMarkup(createElement(Stats, { digest: DIGEST, days: 7 }));
  assert.match(out, /<a href="\?days=7" aria-current="page">7 days<\/a>/);
  assert.match(out, /<button type="button" aria-pressed="true"><span>Visitors<\/span><strong>12<small> \+20%<\/small><\/strong><\/button>/);
  assert.match(out, /aria-pressed="false"><span>Bounce rate<\/span>/);
  assert.match(out, /1m 15s/);
  assert.match(out, /United Kingdom/);
  assert.match(out, /--share:0\.3333/);
  assert.doesNotMatch(out, /Entry pages|Clicks to X/);
  assert.match(out, /<figure class="chart stats-chart"><div class="chart-canvas" role="img" aria-label="Visitors per day"><\/div>/);
  assert.match(out, /<a href="\?days=all">All time<\/a>/);
});

test('no change from the window before is unsigned', () => {
  const out = renderToStaticMarkup(createElement(Stats, { digest: { ...DIGEST, previous_visitors: 12 }, days: 1 }));
  assert.match(out, /<small> 0%<\/small>/);
});

test('a ?days= value outside the offered windows falls back', () => {
  assert.equal(statsDays('7'), 7);
  assert.equal(statsDays(['7']), 30);
  assert.equal(statsDays('3'), 30);
  assert.equal(statsDays(undefined), 30);
});
