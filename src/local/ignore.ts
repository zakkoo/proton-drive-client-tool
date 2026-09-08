import picomatch from 'picomatch';

import { INTERNAL_DIR_NAME } from '../config/paths.js';

/** Returns true when a root-relative POSIX path is excluded from sync. */
export type IgnoreMatcher = (relPath: string) => boolean;

/**
 * Build a matcher from glob patterns. The internal state directory is always
 * ignored, and a path is ignored when it or any ancestor directory matches.
 */
export function createIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const matchers = patterns.map((p) => picomatch(p, { dot: true }));
  const matchesOne = (p: string): boolean => matchers.some((m) => m(p));
  return (relPath) => {
    if (relPath === '' || relPath === '.') return false;
    if (relPath === INTERNAL_DIR_NAME || relPath.startsWith(`${INTERNAL_DIR_NAME}/`)) return true;
    const parts = relPath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      if (matchesOne(parts.slice(0, i).join('/'))) return true;
    }
    return false;
  };
}
