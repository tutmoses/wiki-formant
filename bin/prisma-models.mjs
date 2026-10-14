#!/usr/bin/env node
// bin/prisma-models.mjs – copy the Prisma models wiki-formant's SQL reads into an
// app's schema folder, or check that the copies there have not drifted.
//
// `wiki-formant/analytics` and `wiki-formant/passkey` own their SQL and name
// their tables as written, so the models are the package's. Three apps carried
// them byte for byte, and the package kept a fourth copy as a comment.
//
// Prisma reads a schema split across the .prisma files of one folder. The app
// points prisma.config.ts at the folder (`schema: 'prisma/schema'`), keeps its
// generator, datasource and own models in prisma/schema/schema.prisma, and this
// writes analytics.prisma and passkey.prisma beside them. Run it from the app's
// root:
//
//   npx prisma-models                   # write both into prisma/schema
//   npx prisma-models --check           # exit 1 if either is missing or differs
//   npx prisma-models analytics         # only the ones named
//   npx prisma-models --dir db/schema   # another folder
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MODELS = ['analytics', 'passkey'];
const args = process.argv.slice(2);
const check = args.includes('--check');
const at = args.indexOf('--dir');
const dir = at >= 0 ? args[at + 1] : 'prisma/schema';
const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--dir');
const unknown = named.filter(n => !MODELS.includes(n));

if (unknown.length || !dir) {
  console.error(`usage: prisma-models [${MODELS.join('|')}…] [--dir <folder>] [--check]`);
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`prisma-models: no ${dir}/ here. Move prisma/schema.prisma into it and point prisma.config.ts's schema at the folder.`);
  process.exit(2);
}

let drift = 0;
for (const name of named.length ? named : MODELS) {
  const shipped = readFileSync(new URL(`../prisma/${name}.prisma`, import.meta.url), 'utf8');
  const target = join(dir, `${name}.prisma`);
  const local = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (local === shipped) continue;
  if (check) {
    drift++;
    console.error(`${target} ${local === null ? 'is missing' : 'differs from wiki-formant'}: run npx prisma-models`);
  } else {
    writeFileSync(target, shipped);
    console.log(`wrote ${target}`);
  }
}
process.exit(drift ? 1 : 0);
