#!/usr/bin/env node
// bin/passkey-invite.mjs – print a single-use link that saves a passkey for a
// site's admin pages (`wiki-formant/passkey`). The first passkey can only come
// from here, so the only way in is through someone who holds the database URL.
//
// Run from the app's root, where `pg` is installed and `.env` holds
// DATABASE_URL (read from the environment first). The link is good for a day.
//
//   npx passkey-invite https://caper.network/stats
//   npx passkey-invite http://localhost:3000/stats --days 7
import { createPasskeyGate } from '../dist/passkey.js';
import { arg, connect } from './_cli.mjs';

const page = process.argv.slice(2).find(a => /^https?:\/\//.test(a));

if (!page) {
  console.error('usage: passkey-invite <page url> [--days n]');
  process.exit(1);
}

let client;
try {
  client = await connect();
  const sql = (query, ...values) => client.query(query, values).then(r => r.rows);
  const url = new URL(page);
  url.searchParams.set('invite', await createPasskeyGate({ sql, rpName: '' }).invite(Number(arg('--days') ?? 1)));
  console.log(url.href);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
