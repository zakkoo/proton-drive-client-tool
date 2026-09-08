// @protontech/crypto ships raw TypeScript sources as its package exports.
// tsc would type-check them with this project's stricter flags and fail.
// We emit declaration files once (postinstall) and point tsconfig `paths`
// at them, so the package is treated as a library (skipLibCheck applies).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'node_modules/@protontech/crypto/src');
const out = path.join(root, 'types/generated/protontech-crypto');
if (!existsSync(src)) {
  console.error('gen-crypto-types: @protontech/crypto not installed');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const tsc = path.join(root, 'node_modules/.bin/tsc');
const args = [
  '--declaration', '--emitDeclarationOnly',
  '--outDir', out,
  '--rootDir', src,
  '--strict', '--skipLibCheck',
  '--module', 'esnext', '--target', 'esnext', '--moduleResolution', 'bundler',
  '--allowImportingTsExtensions', '--rewriteRelativeImportExtensions',
  '--types', 'node',
  '--lib', 'esnext,dom,webworker',
  '--noEmitOnError', 'false',
];
// tsc does not emit for files under node_modules unless they are listed
// explicitly, so every source file is passed as an entry.
const entries = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) entries.push(full);
  }
};
walk(src);
try {
  execFileSync(tsc, [...args, ...entries], { stdio: 'pipe', cwd: root });
} catch (error) {
  // Declarations are still emitted with noEmitOnError=false; report but continue.
  const msg = String(error.stdout ?? error.message);
  const lines = msg.split('\n').filter((l) => l.includes('error TS')).length;
  console.warn(`gen-crypto-types: tsc reported ${lines} diagnostics in upstream sources (declarations emitted anyway)`);
}
if (!existsSync(path.join(out, 'index.d.ts'))) {
  console.error('gen-crypto-types: declaration emit failed');
  process.exit(1);
}
console.log('gen-crypto-types: emitted to', path.relative(root, out));
