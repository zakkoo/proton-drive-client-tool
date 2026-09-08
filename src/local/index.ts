export { createIgnoreMatcher, type IgnoreMatcher } from './ignore.js';
export { DigestCache, FileChangedDuringHashError, type DigestProvider } from './digest.js';
export { diffSnapshots, type LocalChange } from './diff.js';
export { LocalWatcher, type LocalWatcherEvent, type LocalWatcherOptions } from './watcher.js';
export {
  invalidNameReason,
  RootUnavailableError,
  scanLocalTree,
  statRoot,
  type LocalEntry,
  type LocalKind,
  type LocalSnapshot,
  type UnsyncableEntry,
  type UnsyncableReason,
} from './snapshot.js';
