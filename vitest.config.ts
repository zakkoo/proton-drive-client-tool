import { defineConfig } from 'vitest/config';

// Proton packages ship bundler-style sources (raw .ts, extensionless imports);
// they must go through Vite's transform pipeline, and the browser-only
// `openpgp/lightweight` entry is aliased to the Node build (as Proton's own CLI does).
const resolve = { alias: { 'openpgp/lightweight': 'openpgp' } };
const server = { deps: { inline: [/@protontech\//] } };

export default defineConfig({
  resolve,
  test: {
    projects: [
      {
        resolve,
        test: {
          server,
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.fault.test.ts'],
        },
      },
      {
        resolve,
        test: {
          server,
          name: 'fault',
          include: ['src/**/*.fault.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
