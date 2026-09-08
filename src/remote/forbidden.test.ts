import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Permanent deletion must be structurally unreachable. Besides the ESLint
 * rule, this scan asserts the SDK's destructive methods are never even named
 * anywhere in src/ except in this test and in comments of the adapter that
 * document their absence.
 */
const FORBIDDEN = ['deleteNodes', 'emptyTrash', 'deleteRevision'];
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('permanent deletion is unreachable', () => {
  it('no source file references the SDK delete methods', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('forbidden.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (code.trim().startsWith('*')) return; // doc comment line
        for (const token of FORBIDDEN) {
          if (new RegExp(`\\b${token}\\b`).test(code)) offenders.push(`${path.relative(SRC, file)}:${String(i + 1)}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the SdkClient adapter type does not expose the delete methods', async () => {
    const source = readFileSync(path.join(SRC, 'remote', 'sdkRemoteDrive.ts'), 'utf8');
    const iface = /export interface SdkClient \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(iface).toContain('trashNodes');
    for (const token of FORBIDDEN) expect(iface).not.toContain(token);
    const mod = await import('./sdkRemoteDrive.js');
    expect(Object.keys(mod.SdkRemoteDrive.prototype)).not.toContain('delete');
  });
});
