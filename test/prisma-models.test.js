import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = new URL('../bin/prisma-models.mjs', import.meta.url).pathname;
const run = (cwd, ...args) => {
  try {
    return { code: 0, out: execFileSync('node', [bin, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

test('prisma-models writes the shipped models and --check fails on drift', () => {
  const app = mkdtempSync(join(tmpdir(), 'wf-models-'));
  assert.equal(run(app).code, 2, 'no schema folder is a usage error, not a silent mkdir');
  mkdirSync(join(app, 'prisma/schema'), { recursive: true });

  assert.equal(run(app, '--check').code, 1, 'missing copies fail the check');
  assert.equal(run(app).code, 0);
  const shipped = readFileSync(new URL('../prisma/analytics.prisma', import.meta.url), 'utf8');
  assert.equal(readFileSync(join(app, 'prisma/schema/analytics.prisma'), 'utf8'), shipped);
  assert.equal(run(app, '--check').code, 0);

  writeFileSync(join(app, 'prisma/schema/passkey.prisma'), 'model Passkey { id String @id }\n');
  const drift = run(app, '--check');
  assert.equal(drift.code, 1);
  assert.match(drift.out, /passkey\.prisma differs/);
  assert.equal(run(app, 'analytics', '--check').code, 0, 'only the named models are checked');
});

test('--in checks hand-written models in one schema file, and --tenant allows a site relation', () => {
  const app = mkdtempSync(join(tmpdir(), 'wf-models-'));
  const shipped = readFileSync(new URL('../prisma/analytics.prisma', import.meta.url), 'utf8');
  const tenanted = shipped
    .replace(/siteId(\s+)String\s+@default\(""\)/g, 'siteId$1String')
    .replace(/(model (?:View|Event) \{[\s\S]*?)(\n\n  @@index)/g, '$1\n  site Site @relation(fields: [siteId], references: [id], onDelete: Cascade)$2');
  writeFileSync(join(app, 'schema.prisma'), `// mine\nmodel Site { id String @id }\n${tenanted}`);
  assert.equal(run(app, 'analytics', '--check', '--in', 'schema.prisma').code, 1, 'a relation is drift without --tenant');
  assert.equal(run(app, 'analytics', '--check', '--in', 'schema.prisma', '--tenant').code, 0);
  writeFileSync(join(app, 'schema.prisma'), tenanted.replace('  device    String\n', ''));
  const drift = run(app, 'analytics', '--check', '--in', 'schema.prisma', '--tenant');
  assert.equal(drift.code, 1);
  assert.match(drift.out, /model View differs/);
  assert.equal(run(app, '--in', 'schema.prisma').code, 2, '--in only checks');
});
