import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RootIdentity {
  dev: number;
  ino: number;
  /**
   * Directory creation time. Optional for backward compatibility with configs
   * written before this field existed. It distinguishes a replaced directory
   * that reused the same inode (which happens on some filesystems, e.g. CI
   * runners) from the original — `dev`/`ino` alone cannot.
   */
  birthtimeMs?: number;
  /**
   * Stable btrfs identity (`btrfs:<source>:subvolid=<id>`). Optional.
   * Btrfs `dev` is an anonymous device number assigned at mount time, so the
   * same directory reports a different `dev` after a reboot. Configs written
   * before this field existed have only `dev` and `ino`.
   */
  fsKey?: string;
}

export interface LocalRootContext {
  home?: string;
  /** Roots already in use (e.g. the previously configured root when re-running setup). */
  existingRoots?: readonly string[];
}

const FORBIDDEN_PREFIXES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/tmp'];

function isSameOrAncestor(ancestor: string, p: string): boolean {
  const rel = path.relative(ancestor, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validate a candidate local sync root. Returns a list of problems (empty when valid).
 *
 * Rejects: relative paths, non-directories, unwritable directories, the home
 * directory itself or any of its ancestors, the filesystem root, system
 * directories, and any path equal to, inside, or containing an existing root.
 */
export function validateLocalRoot(candidate: string, ctx: LocalRootContext = {}): string[] {
  const problems: string[] = [];
  if (!path.isAbsolute(candidate)) {
    problems.push('local root must be an absolute path');
    return problems;
  }
  const root = path.resolve(candidate);
  const home = path.resolve(ctx.home ?? os.homedir());

  if (root === '/') problems.push('local root must not be the filesystem root');
  if (root === home) problems.push('local root must not be the home directory itself');
  if (root !== home && isSameOrAncestor(root, home)) problems.push('local root must not contain the home directory');
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (isSameOrAncestor(prefix, root)) {
      problems.push(`local root must not be inside the system directory ${prefix}`);
      break;
    }
  }
  for (const existing of ctx.existingRoots ?? []) {
    const ex = path.resolve(existing);
    if (ex === root) problems.push(`local root ${root} is already configured`);
    else if (isSameOrAncestor(ex, root)) problems.push(`local root ${root} is inside the already configured root ${ex}`);
    else if (isSameOrAncestor(root, ex)) problems.push(`local root ${root} contains the already configured root ${ex}`);
  }

  let st;
  try {
    st = statSync(root);
  } catch {
    problems.push(`local root ${root} does not exist`);
    return problems;
  }
  if (!st.isDirectory()) problems.push(`local root ${root} is not a directory`);
  try {
    accessSync(root, constants.W_OK | constants.R_OK | constants.X_OK);
  } catch {
    problems.push(`local root ${root} is not readable and writable`);
  }
  return problems;
}

/** The file system identity of a directory, used to detect a replaced root. */
export function readRootIdentity(root: string): RootIdentity {
  const st = statSync(root);
  const fsKey = filesystemKey(path.resolve(root));
  return { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs, ...(fsKey !== undefined ? { fsKey } : {}) };
}

/**
 * Btrfs volume key for `root`, from the mount that covers it. Undefined when
 * mount info is unavailable or the directory is not on btrfs: other filesystems
 * have a stable `dev`, and a bare `tmpfs` source would collide across mounts.
 */
export function filesystemKey(root: string, mountinfo = readMountinfo()): string | undefined {
  if (mountinfo === undefined) return undefined;
  let best: { len: number; key: string } | undefined;
  for (const line of mountinfo.split('\n')) {
    const parsed = parseMountinfoLine(line);
    if (parsed === undefined) continue;
    if (parsed.fstype !== 'btrfs' || parsed.subvolid === undefined) continue;
    if (!covers(parsed.mountPoint, root)) continue;
    if (best === undefined || parsed.mountPoint.length > best.len) {
      best = { len: parsed.mountPoint.length, key: `btrfs:${parsed.source}:subvolid=${parsed.subvolid}` };
    }
  }
  return best?.key;
}

/** Live identity to store when it is the same directory with a refreshed device number or filesystem key. Null when nothing should be written. */
export function adoptedRootIdentity(recorded: RootIdentity, live: RootIdentity): RootIdentity | null {
  if (!sameIdentity(live, recorded)) return null;
  if (recorded.dev === live.dev && recorded.ino === live.ino && recorded.birthtimeMs === live.birthtimeMs && recorded.fsKey === live.fsKey) return null;
  return live;
}

export function sameIdentity(a: RootIdentity, b: RootIdentity): boolean {
  if (a.ino !== b.ino) return false;
  // Only compare creation time when both identities carry it (older configs did not); a difference
  // there means the directory was replaced even if the inode was reused.
  if (a.birthtimeMs !== undefined && b.birthtimeMs !== undefined && a.birthtimeMs !== b.birthtimeMs) return false;
  if (a.fsKey !== undefined && b.fsKey !== undefined) return a.fsKey === b.fsKey;
  if (a.dev === b.dev) return true;
  // A config from before fsKey existed compared the anonymous btrfs device number.
  // The inode still identifies the directory; the live key says which volume it is.
  const key = a.fsKey ?? b.fsKey;
  return key?.startsWith('btrfs:') === true;
}

function readMountinfo(): string | undefined {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return undefined;
  }
}

interface MountLine {
  mountPoint: string;
  fstype: string;
  source: string;
  subvolid: string | undefined;
}

function parseMountinfoLine(line: string): MountLine | undefined {
  const sep = line.indexOf(' - ');
  if (sep < 0) return undefined;
  const mountPoint = line.slice(0, sep).split(' ')[4];
  const right = line.slice(sep + 3).split(' ');
  const fstype = right[0];
  const source = right[1];
  if (mountPoint === undefined || fstype === undefined || source === undefined) return undefined;
  const superOptions = right.slice(2).join(' ');
  return {
    mountPoint: unescapeMount(mountPoint),
    fstype,
    source: unescapeMount(source),
    subvolid: /(?:^|,)subvolid=(\d+)/.exec(superOptions)?.[1],
  };
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function covers(mountPoint: string, root: string): boolean {
  return mountPoint === '/' || root === mountPoint || root.startsWith(`${mountPoint}/`);
}
