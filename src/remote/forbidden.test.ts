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

/**
 * Every production file that removes a file from disk, and how many removal
 * calls it makes. Only `safety/recycle.ts` ever removes *user* content, and
 * only on the explicit `recycle purge` command; every other entry removes an
 * internal temp, lock, socket, secret, or state file. A new removal call — or a
 * new file that removes anything — makes the counts diverge and fails the test,
 * forcing a reviewer to justify it here. This is the unlink allow-list.
 */
const REMOVAL_ALLOW_LIST: Record<string, number> = {
  'audit/logger.ts': 1, // rotate out an old audit log segment
  'config/secretStore.ts': 1, // delete the secret file once it holds nothing
  'engine/control.ts': 2, // remove the control socket file
  'execute/localWrite.ts': 1, // drop the temp file after a failed atomic write
  'execute/recovery.ts': 1, // sweep orphaned temp files on journal recovery
  'remote/transfer.ts': 1, // drop the partial download temp file
  'safety/recycle.ts': 1, // rmSync a recycle bucket on explicit purge (the only user-data removal)
  'state/crashChild.ts': 2, // remove the crash-detection lock file
  'state/store.ts': 4, // remove lock and superseded backup/state files
};

describe('permanent deletion is unreachable', () => {
  // @spec test-suite/Source scan
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

  // @spec test-suite/Source scan
  it('no file removes anything from disk except the allow-listed internal and recycle-purge sites', () => {
    const counts: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replaceAll(path.sep, '/');
      if (rel.endsWith('.test.ts') || rel.startsWith('testing/')) continue; // tests and fakes clean up their own temp trees
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, ''))
        .filter((line) => !line.trim().startsWith('*'))
        .join('\n');
      const matches = code.match(/\b(?:unlink|unlinkSync|rmSync)\s*\(/g);
      if (matches !== null && matches.length > 0) counts[rel] = matches.length;
    }
    // Exact match: a new removal call (or a removal in a new file) diverges and fails here.
    expect(counts).toEqual(REMOVAL_ALLOW_LIST);
  });
});
