// knip.ts — the dead-code config every app here shares. An app's own knip.ts
// spreads it and appends what only it has: `{ ...base, ignoreBinaries:
// [...base.ignoreBinaries, 'ffmpeg'] }`. Each had kept a copy, and the copies
// drifted on the one line that matters most: a glob that does not name
// `.well-known` skips a dotted directory and every agent-surface route in it.

const entry = [
  // What the App Router loads by convention and nothing imports.
  'src/app/**/page.tsx',
  'src/app/**/layout.tsx',
  'src/app/**/route.{ts,tsx}',
  'src/app/**/{error,not-found,loading,global-error}.tsx',
  'src/app/.well-known/**/route.ts',
  'src/app/**/{sitemap,robots,manifest,opengraph-image,icon,apple-icon}.{ts,tsx}',
  'src/proxy.ts',
  // A module exporting for its test alone reads as dead without the test.
  'src/**/*.test.ts',
  // The routines run these from the command line, and they reach into `src`.
  'scripts/**/*.{ts,mts,mjs}',
  'studio/**/*.mjs',
];

export default {
  entry,
  project: ['src/**/*.{ts,tsx}', 'scripts/**/*.{ts,mts,mjs}', 'studio/**/*.mjs'],
  ignore: ['src/generated/**'],
  // The generated Prisma client imports the first; the second is reached through
  // `@tailwindcss/postcss` and a stylesheet `@import`, neither an import edge.
  ignoreDependencies: ['@prisma/client', 'tailwindcss'],
  // The global CLI the scripts' cache invalidation shells out to, kept out of the
  // dependencies because it put ~330 packages into every build.
  ignoreBinaries: ['vercel'],
};
