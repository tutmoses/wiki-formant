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
import pg from 'pg';
import { createPasskeyGate } from '../dist/passkey.js';

const args = process.argv.slice(2);
const page = args.find(a => /^https?:\/\//.test(a));
const days = Number(args[args.indexOf('--days') + 1] ?? 1);

if (!page) {
  console.error('usage: passkey-invite <page url> [--days n]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // reported below
  }
}
if (!process.env.DATABASE_URL) {
  console.error('no DATABASE_URL in the environment or ./.env');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const sql = (query, ...values) => client.query(query, values).then(r => r.rows);
  const url = new URL(page);
  url.searchParams.set('invite', await createPasskeyGate({ sql, rpName: '' }).invite(args.includes('--days') ? days : 1));
  console.log(url.href);
} finally {
  await client.end().catch(() => {});
}
