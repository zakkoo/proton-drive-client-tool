/**
 * Crash-injection helper run as a separate Node process (type-stripped).
 *
 * Usage: node src/state/crashChild.ts <dbFile> <mode>
 *   mode = "kill-mid-transaction": open a transaction, write half of a baseline
 *          row update, then SIGKILL itself before COMMIT.
 *   mode = "kill-after-commit": commit a full update, then SIGKILL itself.
 *
 * The parent asserts that the store afterwards holds either the complete old
 * row or the complete new row, never a mix.
 */
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [, , dbFile, mode] = process.argv;
if (dbFile === undefined || mode === undefined) {
  process.stderr.write('usage: crashChild <dbFile> <mode>\n');
  process.exit(2);
}

// The parent holds no lock while the child runs; write our own so the store's
// lock semantics are respected even here.
const lockFile = `${dbFile}.lock`;
try {
  const fd = openSync(lockFile, 'wx');
  closeSync(fd);
} catch {
  process.stderr.write('lock exists\n');
  process.exit(3);
}

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = FULL');

const NEW = { size: 999, mtime: 999_999, sha1: 'new-sha1-new-sha1-new-sha1-new-sha1-new0', revision: 'rev-new', remoteSha1: 'new-sha1-new-sha1-new-sha1-new-sha1-new0' };

db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE baseline SET local_size = ?, local_mtime_ms = ? WHERE rel_path = ?').run(NEW.size, NEW.mtime, 'victim.txt');
if (mode === 'kill-mid-transaction') {
  // Half the row is updated inside the open transaction; die now.
  process.stdout.write('killing mid-transaction\n');
  unlinkSync(lockFile);
  process.kill(process.pid, 'SIGKILL');
}
db.prepare('UPDATE baseline SET local_sha1 = ?, revision_uid = ?, remote_sha1 = ? WHERE rel_path = ?').run(NEW.sha1, NEW.revision, NEW.remoteSha1, 'victim.txt');
db.exec('COMMIT');
process.stdout.write('committed\n');
unlinkSync(lockFile);
process.kill(process.pid, 'SIGKILL');
