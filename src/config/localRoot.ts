import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RootIdentity {
  dev: number;
  ino: number;
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

/** The file system identity of a directory, used to detect a replaced or remounted root. */
export function readRootIdentity(root: string): RootIdentity {
  const st = statSync(root);
  return { dev: st.dev, ino: st.ino };
}

export function sameIdentity(a: RootIdentity, b: RootIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
