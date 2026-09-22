import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../..');
const install = path.join(repo, 'scripts/install-engine');
const remove = path.join(repo, 'scripts/remove-engine');

let home: string;

function writeStub(name: string, body: string): void {
  const file = path.join(home, 'bin', name);
  writeFileSync(file, body, { mode: 0o755 });
}

function symlinks(dir: string): string[] {
  const out = execFileSync('find', [dir, '-name', '.git', '-prune', '-o', '-type', 'l', '-print'], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line !== '').sort();
}

function run(script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(script, args, {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`,
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CONFIG_HOME: path.join(home, 'config'),
      ...extra,
    },
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pds-engine-install-'));
  mkdirSync(path.join(home, 'bin'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function nodeStub(tooOld: boolean): void {
  writeStub(
    'node',
    `#!/bin/bash
if [[ "$1" == "-e" ]]; then exit ${tooOld ? '1' : '0'}; fi
if [[ "$1" == "-v" ]]; then echo "${tooOld ? 'v20.0.0' : 'v24.0.0'}"; exit 0; fi
if [[ -f "$1" ]]; then printf '%s\\n' "$1" >> "$HOME/node-runs.log"; exit 0; fi
exit 1
`,
  );
}

function npmStub(): void {
  writeStub(
    'npm',
    `#!/bin/bash
printf '%s\\n' "$PWD" >> "$HOME/npm-cwd.log"
printf '%s\\n' "$*" >> "$HOME/npm-args.log"
if [[ "$1" == "run" && "$2" == "build" ]]; then
  mkdir -p dist/cli
  printf '%s\\n' '#!/usr/bin/env node' 'console.log("runtime")' > dist/cli/main.js
fi
exit 0
`,
  );
}

function systemctlStub(): void {
  writeStub(
    'systemctl',
    `#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
exit 0
`,
  );
}

describe('engine install and removal', () => {
  it('refuses Node older than 24 without writing anything', () => {
    nodeStub(true);
    const result = run(install);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Node\.js 24/);
    expect(result.stderr).not.toMatch(/npm/);
    const entries = execFileSync('find', [home, '-mindepth', '1', '-print'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(entries).toEqual([path.join(home, 'bin'), path.join(home, 'bin/node')].sort());
  });

  it('installs the runtime outside the plugin directory and leaves no new symlink there', () => {
    nodeStub(false);
    npmStub();
    const before = symlinks(repo);
    const result = run(install);
    expect(result.status).toBe(0);
    expect(symlinks(repo)).toEqual(before);
    const cwd = readFileSync(path.join(home, 'npm-cwd.log'), 'utf8');
    expect(cwd).not.toContain(repo);
    expect(cwd).toContain(path.join(home, 'data'));
    const args = readFileSync(path.join(home, 'npm-args.log'), 'utf8');
    expect(args).toContain('ci');
    expect(args).not.toContain('install ');
    const runtime = path.join(home, 'data/proton-drive-sync/runtime');
    expect(readFileSync(path.join(runtime, '.installed-by'), 'utf8').trim()).toBe('io.github.zakkoo.proton-drive');
    const launcher = path.join(home, '.local/bin/proton-drive-sync');
    const text = readFileSync(launcher, 'utf8');
    expect(text).toContain('# installed-by=io.github.zakkoo.proton-drive');
    expect(text).toContain(`# runtime=${runtime}`);
    expect(text).not.toContain('sudo');
    const ran = run(launcher, ['--version']);
    expect(ran.status).toBe(0);
    expect(readFileSync(path.join(home, 'node-runs.log'), 'utf8')).toContain(path.join(runtime, 'dist/cli/main.js'));
  });

  it('refuses a runtime path inside the plugin directory or a symlinked runtime', () => {
    nodeStub(false);
    npmStub();
    const inside = run(install, [], { XDG_DATA_HOME: repo });
    expect(inside.status).not.toBe(0);
    expect(inside.stderr).toMatch(/outside the plugin directory/);

    const data = path.join(home, 'data');
    mkdirSync(path.join(data, 'proton-drive-sync'), { recursive: true });
    symlinkSync('/tmp', path.join(data, 'proton-drive-sync/runtime'));
    const linked = run(install);
    const runtimeLink = path.join(data, 'proton-drive-sync/runtime');
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toMatch(/symlink/);
    expect(lstatSync(runtimeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(runtimeLink)).toBe('/tmp');
  });

  it('does not replace a foreign launcher or a pre-existing unit', () => {
    nodeStub(false);
    npmStub();
    systemctlStub();
    const launcher = path.join(home, '.local/bin/proton-drive-sync');
    mkdirSync(path.dirname(launcher), { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\necho foreign\n');
    const foreign = run(install, ['--service']);
    expect(foreign.status).not.toBe(0);
    expect(readFileSync(launcher, 'utf8')).toBe('#!/bin/sh\necho foreign\n');
    expect(existsSync(path.join(home, 'data'))).toBe(false);

    rmSync(launcher);
    const unit = path.join(home, 'config/systemd/user/proton-drive-sync.service');
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, '[Service]\nExecStart=/usr/bin/false\n');
    const before = readFileSync(unit);
    const kept = run(install, ['--service']);
    expect(kept.status).toBe(0);
    expect(readFileSync(unit)).toEqual(before);
    expect(kept.stderr).toMatch(/existing unit was left in place/);
    expect(() => readFileSync(path.join(home, 'systemctl.log'))).toThrow();
  });

  it('writes one --no-tray unit and a second --service run leaves it and the launcher path', () => {
    nodeStub(false);
    npmStub();
    systemctlStub();
    const first = run(install, ['--service']);
    expect(first.status).toBe(0);
    const unit = path.join(home, 'config/systemd/user/proton-drive-sync.service');
    const unitBytes = readFileSync(unit);
    expect(unitBytes.toString()).toContain('# installed-by=io.github.zakkoo.proton-drive');
    expect(unitBytes.toString()).toContain('run --no-tray');
    expect(unitBytes.toString()).not.toContain('sudo');
    const launcher = path.join(home, '.local/bin/proton-drive-sync');
    const launcherBytes = readFileSync(launcher);
    const log = readFileSync(path.join(home, 'systemctl.log'), 'utf8');
    expect(log).toContain('enable --now proton-drive-sync.service');

    const second = run(install, ['--service']);
    expect(second.status).toBe(0);
    expect(readFileSync(unit)).toEqual(unitBytes);
    expect(readFileSync(launcher)).toEqual(launcherBytes);
    expect(path.resolve(launcher)).toBe(launcher);
  });

  it('remove-engine deletes only the marked runtime, launcher, and unit', () => {
    nodeStub(false);
    npmStub();
    systemctlStub();
    expect(run(install, ['--service']).status).toBe(0);

    const config = path.join(home, 'config/proton-drive-sync/config.json');
    const state = path.join(home, 'data/proton-drive-sync/state.db');
    const audit = path.join(home, 'state/proton-drive-sync/audit/audit.log');
    const recycle = path.join(home, 'Sync/.proton-sync/recycle/keep.txt');
    mkdirSync(path.dirname(config), { recursive: true });
    mkdirSync(path.dirname(audit), { recursive: true });
    mkdirSync(path.dirname(recycle), { recursive: true });
    writeFileSync(config, '{"keep":true}\n');
    writeFileSync(state, 'state\n');
    writeFileSync(audit, 'audit\n');
    writeFileSync(recycle, 'recycled\n');

    expect(run(remove).status).toBe(0);
    expect(() => readFileSync(path.join(home, 'config/systemd/user/proton-drive-sync.service'))).toThrow();
    expect(() => readFileSync(path.join(home, '.local/bin/proton-drive-sync'))).toThrow();
    expect(() => readFileSync(path.join(home, 'data/proton-drive-sync/runtime/.installed-by'))).toThrow();
    expect(readFileSync(config, 'utf8')).toBe('{"keep":true}\n');
    expect(readFileSync(state, 'utf8')).toBe('state\n');
    expect(readFileSync(audit, 'utf8')).toBe('audit\n');
    expect(readFileSync(recycle, 'utf8')).toBe('recycled\n');
  });

  it('remove-engine leaves a unit that this plugin did not write', () => {
    nodeStub(false);
    npmStub();
    const unit = path.join(home, 'config/systemd/user/proton-drive-sync.service');
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, '[Service]\nExecStart=/elsewhere/proton-drive-sync run\n');
    expect(run(install).status).toBe(0);
    expect(run(remove).status).toBe(0);
    expect(readFileSync(unit, 'utf8')).toContain('/elsewhere/proton-drive-sync');
  });
});
