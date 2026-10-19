#!/usr/bin/env node
// bin/maintenance-log.mjs – state I/O for a wiki-sweep routine's log page.
//
// The routine's memory between runs lives in one wiki page's metadata.state,
// and the page shows it, re-rendered and capped on every write (the rules are
// `src/maintenance.ts`). radix-wiki and caper each carried this script with the
// same rules against a different table; the tables are now the package's own
// (`prisma/wiki.prisma`). Run it from the app's root, where `pg` is installed
// and `.env` holds DATABASE_URL.
//
//   npx maintenance-log read                    # print the state as JSON
//   npx maintenance-log write '<json>'          # replace it (or `write -` from stdin)
//   npx maintenance-log compact [--dry-run]     # re-apply the caps to what is stored
//   npx maintenance-log backlog-add '<json>'    # append items under a row lock
//
// with the page named every time:
//
//   --at <tagPath>/<slug>      the log page, e.g. contents/tech/operations/wiki-maintenance-log
//   --routine <name>           named on the page and in the revision message
//   --site <siteId>            the wiki the page belongs to, default "" (a one-wiki app)
//   --author <id>              the revision's authorId, default NULL
//   --invalidate <tag>         `vercel cache invalidate --tag` after a write
//
// `write` takes the whole new state: read, change, write back. A revision is
// written at most once a day, and on every `compact`; other writes edit the
// page in place, because a full copy per run is what made radix-wiki's log
// over half its revisions table. `write` refuses a state whose totalRuns is
// below the stored one: that state was read before another run wrote.
// `backlog-add` is how another routine files an
// item: `write` replaces the whole state, so an append through it could lose a
// concurrent run's, and the row lock serialises the two. A revision bumps the
// page's version a minor.
import { PINNED, addBacklog, compact, render, staleWrite } from '../dist/maintenance.js';
import { bump } from '../dist/versioning.js';
import { arg, connect, invalidate } from './_cli.mjs';

const args = process.argv.slice(2);
const [mode, payload] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(?!dry-run)/));
const dry = args.includes('--dry-run');
const at = arg('--at') ?? '';
const routine = arg('--routine');
const slugAt = at.lastIndexOf('/');

if (!['read', 'write', 'compact', 'backlog-add'].includes(mode) || slugAt < 1 || !routine) {
  console.error('usage: maintenance-log <read|write|compact|backlog-add> [json|-] --at <tagPath>/<slug> --routine <name> [--site id] [--author id] [--invalidate tag] [--dry-run]');
  process.exit(2);
}
const pages = '"WikiPage"';
const revisions = '"WikiRevision"';
const where = `"tagPath" = $1 AND slug = $2 AND "siteId" = $3`;
const address = [at.slice(0, slugAt), at.slice(slugAt + 1), arg('--site') ?? ''];

const readStdin = async () => {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
};

let client;
const q = (text, values) => client.query(text, values).then(r => r.rows);
let wrote = false;
try {
  client = await connect();
  const today = new Date().toISOString().slice(0, 10);

  if (mode === 'read') {
    const [page] = await q(`SELECT metadata FROM ${pages} WHERE ${where}`, address);
    if (!page) throw new Error(`no log page at ${at}`);
    process.stdout.write(`${JSON.stringify(page.metadata?.state ?? {}, null, 2)}\n`);
  } else if (mode === 'backlog-add') {
    const items = JSON.parse(payload ?? '[]');
    if (!Array.isArray(items) || !items.length) throw new Error('backlog-add expects a non-empty JSON array of items');
    await q('BEGIN');
    const [page] = await q(`SELECT id, metadata FROM ${pages} WHERE ${where} FOR UPDATE`, address);
    if (!page) throw new Error(`no log page at ${at}`);
    const state = page.metadata?.state ?? {};
    const added = addBacklog(state, items, today);
    if (!added.length) {
      await q('ROLLBACK');
      console.log('  nothing to add (all duplicates)');
    } else {
      const next = compact({ ...state, backlog: [...(state.backlog ?? []), ...added] });
      console.log(`  ${dry ? '[dry] ' : ''}+${added.length} backlog item(s), ${next.backlog.length} open`);
      for (const a of added) console.log(`     ${a.item}`);
      if (dry) await q('ROLLBACK');
      else {
        await q(`UPDATE ${pages} SET content = $1, metadata = $2, "updatedAt" = now() WHERE id = $3`, [
          JSON.stringify(render(next, routine)),
          JSON.stringify({ state: next, lastVerified: today }),
          page.id,
        ]);
        await q('COMMIT');
        wrote = true;
      }
    }
  } else {
    const [page] = await q(`SELECT * FROM ${pages} WHERE ${where}`, address);
    if (!page) throw new Error(`no log page at ${at}`);
    let input = page.metadata?.state ?? {};
    if (mode === 'write') {
      const text = payload === undefined || payload === '-' ? await readStdin() : payload;
      if (!text.trim()) throw new Error('write needs the state as JSON, as an argument or on stdin with `write -`');
      input = JSON.parse(text);
      const stale = staleWrite(page.metadata?.state ?? {}, input);
      if (stale) throw new Error(stale);
    }
    const state = compact(input);
    const content = render(state, routine);

    const [last] = await q(
      `SELECT "createdAt" FROM ${revisions} WHERE "pageId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [page.id],
    );
    const revise = mode === 'compact' || !last || last.createdAt.toISOString().slice(0, 10) !== today;
    const version = revise ? bump(page.version, 'minor') : page.version;

    for (const key of ['backlog', 'runHistory', 'feedback']) {
      const [before, after] = [(input[key] ?? []).length, state[key].length];
      if (before !== after) console.log(`  ${key}: ${before} → ${after}`);
    }
    const kept = new Set(state.backlog.map(b => b.item));
    for (const b of input.backlog ?? []) {
      const item = typeof b === 'string' ? b : b.item;
      if (PINNED.test(item ?? '') && (typeof b === 'string' || (b.status ?? 'open') === 'open') && !kept.has(item)) {
        console.log(`  flag dropped over the cap: ${item}`);
      }
    }
    console.log(
      `  ${dry ? '[dry] ' : ''}state ${JSON.stringify(input).length} → ${JSON.stringify(state).length} B, ` +
        `content ${JSON.stringify(content).length} B${revise ? `, revision v${version}` : ', no revision today'}`,
    );

    if (!dry) {
      await q('BEGIN');
      await q(
        `UPDATE ${pages} SET content = $1, metadata = $2, "updatedAt" = now(), version = $4 WHERE id = $3`,
        [JSON.stringify(content), JSON.stringify({ state, lastVerified: today }), page.id, version],
      );
      if (revise) {
        await q(
          `INSERT INTO ${revisions} ("pageId", title, content, version, "changeType", "authorId", message) VALUES ($1, $2, $3, $4, 'minor', $5, $6)`,
          [
            page.id, page.title, JSON.stringify(content), version, arg('--author') ?? null,
            mode === 'compact'
              ? 'Compact the log: drop closed and duplicated backlog items, cap the append-only lists'
              : `${routine} run ${state.lastRun ?? today}`,
          ],
        );
      }
      await q('COMMIT');
      wrote = true;
      console.log(`log page updated${revise ? ` → v${version}` : ''}`);
    }
  }
} catch (e) {
  await client?.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
  const tag = arg('--invalidate');
  if (wrote && tag) await invalidate(tag);
}
