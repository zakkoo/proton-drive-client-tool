## 1. Project setup

- [x] 1.1 Initialize Node.js LTS TypeScript project (strict mode, ESM, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) with vitest, eslint, and a `pnpm test` / `pnpm typecheck` / `pnpm lint` pipeline; verify all three commands pass on an empty project
- [x] 1.2 Add and pin exact versions of `@protontech/drive-sdk`, `@protontech/crypto`, `@parcel/watcher`, `dbus-next`, SQLite binding (decide `node:sqlite` vs `better-sqlite3` per design D10) and record the decision in design.md; verify `pnpm install` and a smoke import of each package succeed
- [x] 1.3 Create module layout (`remote/`, `local/`, `state/`, `reconcile/`, `execute/`, `safety/`, `conflict/`, `audit/`, `tray/`, `config/`, `cli/`) with an architecture README that mirrors design D3; verify the diagram in the README matches the module list
- [x] 1.4 Set up CI (GitHub Actions or local script) running typecheck, lint, unit tests and fault-injection tests; verify a deliberately failing test blocks the pipeline

## 2. Audit logging

- [x] 2.1 Implement JSON Lines append-only audit logger with size rotation and retention; verify unit tests cover rotation without entry loss and parse-back of every line
- [x] 2.2 Implement secret redaction layer for all log sinks; verify a test that logs a fake token, password and key shows them redacted
- [x] 2.3 Implement `history <path|nodeUid>` query over the audit log including earlier paths after renames; verify a test with a rename sequence returns the full chain

## 3. Configuration and credentials

- [x] 3.1 Implement config file schema and validation (sync root, remote folder, ignore globs, brake thresholds with hard lower bounds, retention, concurrency, dry-run, start-paused) in XDG config dir; verify tests reject home/root/nested roots, zero brake, and out-of-range values
- [x] 3.2 Implement OS secret store adapter (libsecret) with our own service name and explicit opt-in plaintext fallback; verify integration test round-trips a secret and confirms no secret appears in the config file
- [x] 3.3 Implement `setup` CLI command that resolves and records remote root node UID and local root file system identity; verify a test against the fake remote stores both identities

## 4. Remote drive access

- [x] 4.1 Port the CLI's HTTP client (base URL, headers, token refresh, throttling and 5xx backoff with jitter, 4xx as permanent) to Node implementing `ProtonDriveHTTPClient`; verify unit tests with a mock server cover refresh, 429 pause, and no-retry on 4xx
- [ ] 4.2 Port the CLI's SRP login flow (password proof, 2FA, key password derivation, address and key unlocking) implementing `ProtonDriveAccount` and `SRPModule` using `@protontech/crypto`; verify unit tests against recorded fixtures and a manual login against a throwaway Proton account succeeds without echoing secrets (code complete and unit-tested; manual login against a throwaway account still pending)
- [x] 4.3 Implement session persistence and resume, and the "needs login" state on rejected session; verify tests show no local or remote mutation on session rejection
- [x] 4.4 Define our `RemoteDrive` interface (list children, get node, download verified, upload new/revision, rename, move, trash, subscribe events, full listing) and implement it over the SDK, with `deleteNodes`/`emptyTrash` structurally absent; verify a grep-based test asserts those SDK methods are never referenced outside the adapter's forbidden list
- [x] 4.5 Implement verified download (temp file, streaming SHA1, claim comparison, "unverified against source" flag) and verified upload (metadata with mtime and SHA1, post-upload revision check); verify tests with the fake remote cover match, mismatch, missing claim, and interrupted transfer
- [x] 4.6 Implement remote event consumption with persisted cursor, cursor-expired fallback to full listing, and degraded mode on stream silence; verify tests replay event sequences and cursor expiry
- [x] 4.7 Build an in-memory fake remote implementing `RemoteDrive` with fault injection hooks (throttle, timeout with unknown outcome, mismatch); verify contract tests pass against both the fake and the SDK adapter in recorded mode

## 5. Local filesystem watch

- [x] 5.1 Implement full scan producing a local snapshot (relpath, inode, device, size, mtime, lazily computed SHA1, unsyncable flags for symlinks/special files/unreadable) with ignore rules and internal-directory exclusion; verify tests on a temp tree including symlinks and permission-denied files
- [x] 5.2 Implement inotify watcher with per-path debounce and settle detection, overflow handling that forces a full scan, and new-directory pickup; verify tests cover single modified event per burst and folder-move-in with pre-existing children
- [x] 5.3 Implement move detection combining watcher rename pairs and inode+digest matching in scan diffs, emitting separate delete/create on ambiguous evidence; verify tests for rename, cross-folder move, folder move, and inode reuse with different content
- [x] 5.4 Implement "root unavailable" detection; verify a test that removes the root emits one condition and zero delete changes

## 6. Sync state store

- [x] 6.1 Implement SQLite store (WAL, synchronous FULL, integrity check on open, exclusive lock, schema version, migration with backup) with tables for baseline, local snapshot, remote snapshot, journal, cursors, quarantine, conflicts; verify tests for second-instance refusal, corruption refusal, newer-schema refusal, and migration failure leaving pre-state
- [x] 6.2 Implement baseline repository with lookups by path, inode and node UID and atomic upsert; verify a crash-injection test (kill between statements) leaves whole old or whole new rows only
- [x] 6.3 Implement journal repository with state transitions and pre-state fingerprints; verify tests reject illegal transitions

## 7. Reconciliation engine

- [x] 7.1 Define snapshot and plan types, side-state classifier (unchanged, modified, created, moved, movedAndModified, deleted, missingNoBaseline) using digest equality with mtime/size fast path; verify unit tests for each state including same-time-different-content and different-time-same-content
- [x] 7.2 Implement the (localState x remoteState) decision table with every cell as action, conflict(kind) or blocked(reason), rendered in a doc comment; verify a test enumerates every cell and asserts no cell is undefined
- [x] 7.3 Implement move/rename detection and folder-move collapsing; verify tests for remote move, local move, move plus edit ordering, and folder move without descendant re-transfer
- [x] 7.4 Implement deletion rules requiring baseline evidence and unchanged target, with delete-vs-edit as conflict and no-baseline as create; verify tests for all three scenarios
- [x] 7.5 Implement dependency ordering (parents first, moves before folder deletes, structure before content) and case/Unicode collision blocking; verify tests for each ordering rule and case-only collision
- [x] 7.6 Implement snapshot completeness gate (no deletes on incomplete, unavailable or empty-vs-nonempty-baseline snapshots); verify tests for remote-empty and root-unavailable
- [x] 7.7 Write property-based convergence tests: random edit sequences on model local and remote trees, reconcile and apply to model, assert convergence, no data loss, and determinism; verify the suite runs at least 1000 cases in CI

## 8. Data safety guards

- [x] 8.1 Implement recycle directory moves preserving relpath and timestamp, and a separate explicit retention purge command that logs each path; verify tests show no `unlink` of user data anywhere except the purge command
- [x] 8.2 Implement mass-change brake with count and percentage thresholds, held-plan state, confirm/reject flow recorded in audit log; verify tests for threshold exceeded, confirm, reject
- [x] 8.3 Implement first-sync protection (no deletes when no baseline and both sides non-empty); verify a test with divergent non-empty trees produces only creates and conflicts
- [x] 8.4 Implement quarantine store and release flow; verify tests that quarantined items are excluded from plans and never appear in delete or overwrite operations
- [x] 8.5 Implement preflight checks (root identity, store integrity, free space vs plan volume, remote root UID); verify tests for each failure pausing the engine with the correct reason

## 9. Sync execution

- [x] 9.1 Implement executor loop: journal planned, precheck fingerprints, act, verify destination, commit baseline and journal in one transaction; verify tests show baseline unchanged on any failure and updated only after verification
- [x] 9.2 Implement atomic local write protocol (same-FS temp, stream hash, mtime set, recycle old, rename in) with abort on target change and disk-full handling; verify tests for each scenario including target modified mid-download
- [x] 9.3 Implement startup recovery over in-progress journal entries (complete, roll back, abandon with quarantine); verify tests for crash-after-upload, crash-during-download, unknown outcome
- [x] 9.4 Implement bounded concurrency, pause, cancel at operation boundaries, and idempotent retry with destination recheck; verify tests for pause mid-batch, cancel mid-download, retry after unknown-outcome timeout
- [x] 9.5 Implement dry-run mode; verify a test that a non-empty plan under dry-run changes nothing on either side and logs "would do" entries
- [x] 9.6 Build the fault-injection harness: kill/exception at every journal transition and every I/O step across a scripted scenario set; verify after each injected fault that no user file is lost, journal is consistent, and baseline is never ahead of reality

## 10. Conflict handling

- [x] 10.1 Implement content-conflict resolution into two files with deterministic suffix (conflict, machine name, timestamp), remote version at original path, local version uploaded as sibling; verify tests for first and repeated conflict on the same path
- [x] 10.2 Implement delete-vs-edit handling (keep edit, re-transfer, record conflict) and structural conflicts (divergent moves blocked, create-inside-deleted-folder recreates folder); verify tests for each scenario
- [x] 10.3 Implement conflict inbox with keep-local, keep-remote, keep-both resolutions executed as journaled operations using recycle/trash only; verify tests for each resolution

## 11. Engine orchestration and CLI

- [x] 11.1 Implement the sync cycle scheduler (drain deltas, reconcile, gate, execute, single cycle at a time, debounce and timer triggers) and the engine state machine (idle, scanning, syncing, paused, offline, throttled, attention, awaiting confirmation, error, needs login); verify tests for every state transition
- [x] 11.2 Implement typed status object, in-process emitter, and Unix-socket JSON status/control protocol (status, pause, resume, sync-now, confirm, reject, resolve, quit); verify tests drive the engine entirely over the socket
- [x] 11.3 Implement CLI commands: `login`, `logout`, `setup`, `run`, `status`, `pause`, `resume`, `sync-now`, `conflicts`, `quarantine`, `history`, `purge-recycle`, `--dry-run`, `--paused`; verify each command against the fake remote in an integration test
- [x] 11.4 End-to-end scenario suite against fakes: rename storm, folder move with 1000 files, offline edits on both sides, clock skew, case collision, CLI-made remote changes; verify all scenarios converge with zero data loss

## 12. Tray status UI

- [ ] 12.1 Implement StatusNotifierItem over D-Bus with state-specific icons and tooltip, and a dbusmenu with status lines and actions (pause/resume, sync now, open folder, open recycle, open log, settings, quit); verify manually on Hyprland that all states render and every action reaches the engine (code complete: `src/tray/sni.ts`, `menuModel.ts` unit-tested; manual verification on Hyprland pending — no session bus in the build environment)
- [x] 12.2 Implement desktop notifications for conflict, quarantine, held plan, needs login, error only; verify a test that routine sync events produce no notification
- [ ] 12.3 Implement local detail page (transfer list, conflict inbox with resolutions, quarantine view, held-plan review with proceed/reject) served on a Unix socket or localhost and opened from the tray; verify manually that resolving a conflict from the page updates the inbox (code complete and covered by an HTTP test that resolves a conflict through the page; manual browser check pending)
- [x] 12.4 Implement tray-absent behavior (engine keeps running, `status` CLI shows same data); verify a test starting the engine without a D-Bus session bus

## 13. Real-account rollout

- [x] 13.1 Run full test suite and fault-injection suite green as release gate; verify CI status
- [ ] 13.2 Dry-run against a throwaway remote folder and empty local directory, then real sync of the throwaway folder; verify audit log review shows only expected operations
- [ ] 13.3 Dry-run against the real remote folder; verify audit log review shows no unexpected deletes or replacements
- [ ] 13.4 Real sync with most conservative brake thresholds for one week; verify clean audit logs before relaxing thresholds
