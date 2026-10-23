// knip.ts — the knip configuration every app here shares: what the App
// Router loads by convention and nothing imports, the scripts the routines
// run from the command line, and the two dependencies no TS import names.
// An app's `knip.ts` spreads it and adds what is its own:
//
//   import base from 'wiki-formant/knip';
//   export default { ...base, ignoreBinaries: [...base.ignoreBinaries, 'ffmpeg'] };

const config = {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  entry: [
    'src/app/**/page.tsx',
    'src/app/**/layout.tsx',
    'src/app/**/route.{ts,tsx}',
    'src/app/**/{error,not-found,loading,global-error}.tsx',
    // A dotted directory: a glob that does not name it skips the agent surface.
    'src/app/.well-known/**/route.ts',
    'src/app/**/{sitemap,robots,manifest,opengraph-image,icon,apple-icon}.{ts,tsx}',
    'src/**/*.test.ts',
    'scripts/**/*.{ts,mts,mjs}',
    'studio/**/*.mjs',
  ],
  project: ['src/**/*.{ts,tsx}', 'scripts/**/*.{ts,mts,mjs}', 'studio/**/*.mjs'],
  ignoreDependencies: [
    // Reached through `@tailwindcss/postcss` and the `@import` in globals.css.
    'tailwindcss',
    // Imported by the generated Prisma client.
    '@prisma/client',
  ],
  // The Vercel CLI the scripts shell out to for a cache tag; a global, never a dependency.
  ignoreBinaries: ['vercel'],
};

export default config;
