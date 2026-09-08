/**
 * Deterministic conflict-copy naming:
 *   report.pdf  ->  report.conflict-<machine>-20260907T215500.pdf
 * A numeric suffix is appended when the name is already taken, so repeated
 * conflicts never collide and nothing is ever replaced.
 */
import os from 'node:os';

export function machineName(): string {
  return os.hostname().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'machine';
}

export function conflictStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

export function conflictName(fileName: string, machine: string, at: Date, attempt = 0): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const suffix = attempt === 0 ? '' : ` (${String(attempt)})`;
  return `${stem}.conflict-${machine}-${conflictStamp(at)}${suffix}${ext}`;
}

/** First conflict name under `dir` that is not taken according to `exists`. */
export function uniqueConflictPath(relPath: string, machine: string, at: Date, exists: (relPath: string) => boolean): string {
  const i = relPath.lastIndexOf('/');
  const dir = i === -1 ? '' : relPath.slice(0, i);
  const name = i === -1 ? relPath : relPath.slice(i + 1);
  for (let attempt = 0; ; attempt++) {
    const candidate = dir === '' ? conflictName(name, machine, at, attempt) : `${dir}/${conflictName(name, machine, at, attempt)}`;
    if (!exists(candidate)) return candidate;
  }
}

export function isConflictCopy(relPath: string): boolean {
  return /\.conflict-[A-Za-z0-9._-]+-\d{8}T\d{6}/.test(relPath);
}
