// Production bundle. Proton's SDK and crypto packages are shipped bundler-style
// (raw TypeScript, extensionless ESM imports), so the app must be bundled.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/cli/main.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __pdsCreateRequire } from "node:module"; const require = __pdsCreateRequire(import.meta.url);' },
  // Native addons stay external; they are loaded via require at runtime.
  // dbus-next optionally requires 'x11' for X11-property bus discovery; it is not installed and not needed.
  external: ['@parcel/watcher', 'x11'],
  // openpgp/lightweight has no Node entry; Proton's own CLI patches it to the main build.
  alias: { 'openpgp/lightweight': 'openpgp' },
  logLevel: 'info',
});
