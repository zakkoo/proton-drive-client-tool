## Context

See proposal.md for motivation. Facts that shape the design:

- The official Proton Drive SDK (`@protontech/drive-sdk`, TypeScript, npm) provides node CRUD, upload/download with per-revision SHA1 claims, rename/move/trash, revision history, and an event stream (`subscribeToTreeEvents`, `iterateEvents`) with a resumable event ID. It is a pure library: the caller must supply `httpClient`, `account` (addresses and unlocked keys), `openPGPCryptoModule`, `srpModule`, and caches.
- The installed `proton-drive` CLI (v0.8.0) is a Bun bundle of the MIT-licensed reference implementation in `github.com/ProtonDriveApps/sdk` (`cli/src/api`, `cli/src/credentials`, `cli/src/init.ts`). It contains a complete login flow (SRP, 2FA, key unlocking), session persistence in the OS secret store, an HTTP client with token refresh, and a local event cursor store. This is the blueprint for our SDK bootstrapping.
- Proton's crypto is published as `@protontech/crypto` (peer dependency of the SDK) and `@protontech/openpgp`.
- Target machine: Arch Linux, Wayland/Hyprland. Tray via the StatusNotifierItem D-Bus protocol.
- Overriding constraint: data safety beats features and speed.

## Goals / Non-Goals

**Goals:**
- One process, one sync pair, correct under crash, network loss, clock skew, and concurrent edits.
- Reconciliation as a pure function with exhaustive table-driven tests.
- Every mutating step journaled and verified; baseline updated only after verification.
- Engine usable headless (CLI status/commands) so the tray is optional and replaceable.

**Non-Goals:**
- Multiple sync pairs, selective sync of sub-folders, photos/albums, sharing management, Proton Docs/Sheets (skipped as the CLI does).
- Block-level delta transfer; whole-file transfer is acceptable.
- Windows/macOS support in this change (structure should not preclude it).
- Splitting into daemon plus separate tray process (kept possible, not built now).

## Decisions

### D1. Runtime: Node.js LTS (24.x), not Bun
The CLI runs on Bun and uses Bun-only APIs (`Bun.secrets`, `Bun.file`, `Bun.spawn`). We port the reference logic to Node because: inotify watchers, D-Bus bindings, SQLite bindings and OpenPGP.js are all first-class and battle-tested on Node; Bun compatibility for D-Bus and native watchers is uncertain; the SDK itself is runtime-agnostic. Cost: we must replace `Bun.secrets` with libsecret access (via `secret-tool` or a maintained keyring binding) and `Bun.file` with `node:fs`.
*Alternative considered:* Bun, to copy the CLI verbatim. Rejected for ecosystem risk in the tray and watcher layers.

### D1a. Build: esbuild bundle, vitest transform for tests
Both `@protontech/drive-sdk` (extensionless ESM imports in `dist/`) and `@protontech/crypto` (raw `.ts` sources as package exports) are shipped bundler-style and cannot be imported by plain Node. Proton's own CLI is a Bun bundle for the same reason. We therefore bundle the app with esbuild (`scripts/build.mjs`, single ESM file, `@parcel/watcher` external for its native addon) and inline `@protontech/*` through Vite's transform in vitest. `tsc` is used for type checking only. SRP is provided by `@protontech/crypto/srp`, which shrinks the login port in D2.

### D2. Auth and SDK bootstrap: port the MIT CLI's `api`, `credentials` and `init` layers
We implement `ProtonDriveAccount`, `ProtonDriveHTTPClient`, `SRPModule` and use the SDK's `OpenPGPCryptoWithCryptoProxy` with `@protontech/crypto`, following the CLI source. The session (UID, access/refresh tokens, key password, cache password) is stored under our own secret-store service name, never shared with the CLI's entry, so the two tools never race on token refresh. Login is an interactive CLI command (`login`) supporting 2FA.
*Alternative considered:* reuse the CLI's stored session. Rejected: shared refresh tokens cause one client to invalidate the other. *Alternative:* shell out to the CLI for everything. Rejected in proposal (no node IDs, no events).

### D3. Architecture: pipeline of five stages around a SQLite core

```
  +-----------------+     +------------------+
  | Local watcher   |     | Remote events    |
  | inotify + scan  |     | SDK subscribe +  |
  |                 |     | periodic listing |
  +--------+--------+     +---------+--------+
           |  local snapshot deltas   |  remote snapshot deltas
           v                          v
  +------------------------------------------------+
  |  Snapshot store (SQLite)                       |
  |   local_nodes | remote_nodes | baseline        |
  |   journal | cursors | quarantine | conflicts   |
  +----------------------+-------------------------+
                         | (baseline, local, remote)
                         v
  +------------------------------------------------+
  |  Reconciler  (pure, no I/O)  -> Plan           |
  +----------------------+-------------------------+
                         | Plan
                         v
  +------------------------------------------------+
  |  Safety gate: preflight, brake, first-sync     |
  +----------------------+-------------------------+
                         | approved Plan
                         v
  +------------------------------------------------+
  |  Executor: journal -> precheck -> do ->        |
  |            verify -> commit baseline           |
  +----------------------+-------------------------+
                         | status events
                         v
  +------------------+   +------------------------+
  | Tray (SNI/D-Bus) |   | CLI status / audit log |
  +------------------+   +------------------------+
```

A sync cycle is: drain pending local and remote deltas into the snapshot tables, run the reconciler on the full three-way view, gate, execute, repeat. Cycles are triggered by debounced change arrival or a timer; only one cycle runs at a time.
*Alternative considered:* event-driven per-file handlers. Rejected: ordering and dependency bugs are the classic source of sync data loss; a whole-tree plan is easier to reason about and test.

### D4. Identity model
- Remote identity: SDK node UID (stable across rename/move). Content identity: active revision UID plus SHA1.
- Local identity: (device, inode) pair plus SHA1; path is an attribute, not an identity. Inode reuse is guarded by requiring digest match for move detection.
- Baseline row links one local identity to one remote identity. Lookups by path, inode and node UID are all indexed.

### D5. Reconciler as a pure module with a typed decision table
Inputs are three immutable maps keyed by baseline row (plus orphans on either side). Output is a `Plan` of typed operations with an `evidence` field. The per-item decision is a lookup in an explicit table of (localState x remoteState) -> action, where states are `unchanged | modified | created | moved | movedAndModified | deleted | missingNoBaseline`. Every cell is either an action, `conflict(kind)`, or `blocked(reason)`. The table is rendered in a doc comment and tested cell by cell, then with property-based tests (random edit sequences applied to a model tree must converge to equality with no data loss).

### D6. Journal and commit protocol
Each operation goes: `planned -> in_progress -> {completed | failed | abandoned}` in a SQLite table, with the pre-state fingerprint (revision UID / inode+mtime+size) recorded at planning. Executor rechecks the fingerprint immediately before acting. Completion writes journal status and baseline row in one transaction. Recovery on startup walks `in_progress` rows and consults both sides to decide completion or abandonment. SQLite runs in WAL mode with `synchronous=FULL`.

### D7. Local write protocol
Download to `<root>/.proton-sync/tmp/<uuid>` (same file system, so rename is atomic), hash while streaming, compare with claim, set mtime, then: if a target exists, `rename(target -> .proton-sync/recycle/<ts>/<relpath>)`, then `rename(tmp -> target)`. Never `unlink` user data. Never write over an existing inode.

### D8. Deletes
Remote: `trashNodes` only; `deleteNodes` and `emptyTrash` are not wired into the executor at all (compile-time absence, not a runtime flag). Local: move to recycle, retention purge is a separate explicit command that logs every path.

### D9. Local watcher
`@parcel/watcher` (native inotify, handles recursive directories and coalesces events) plus our own full scan using `fs.opendir` and `lstat`. Move detection: watcher rename pairs where available, otherwise inode+digest matching in the scan diff. Debounce per path; a file is considered settled when size and mtime are stable across two samples.
*Alternative:* chokidar. Acceptable fallback; parcel is lighter and reports inode-stable renames better.

### D10. State store
SQLite via `node:sqlite` (built into Node; verified working on Node 26.8 with SQLite 3.53 at project setup, so `better-sqlite3` is not needed). Single file in `$XDG_DATA_HOME/proton-drive-sync/state.db`, exclusive lock file, `PRAGMA integrity_check` on open, schema version table, backup copy before migration.

### D11. Tray
StatusNotifierItem over D-Bus using `dbus-next` (pure JS): icon, tooltip, and a `com.canonical.dbusmenu` menu with status lines, actions, and submenus for conflicts, quarantine and held plans. Richer views (transfer list, conflict resolution with both versions) open a small local web page served on a Unix socket or localhost, rendered in the default browser, because dbusmenu cannot show tables. Desktop notifications via `org.freedesktop.Notifications`.
*Alternative:* Electron or Tauri tray app. Rejected: heavy, and the engine should not depend on a GUI toolkit.

### D12. Status and control surface
The engine exposes a typed status object (state, reason, counts, in-flight transfers, attention lists) via an in-process event emitter and via a Unix socket JSON protocol. The tray and the `status` CLI command are both clients of that protocol, which is what later allows the daemon split with no engine change.

### D13. Testing strategy (non-negotiable)
- Reconciler: exhaustive decision-table tests plus property-based convergence tests using a fake in-memory local FS and fake remote.
- Executor: fake remote and temp-dir local FS with fault injection (kill between every journal transition, network errors, disk full, mtime changes mid-transfer). Assertion after every injected fault: no user file lost, journal consistent, baseline never ahead of reality.
- Remote adapter: contract tests against a recorded/fake SDK, and a manual smoke suite against a dedicated throwaway Proton test folder, never the user's real data, until the full suite is green.
- End-to-end: scripted scenarios (rename storm, move folder with 1000 files, offline edits both sides, clock skew, case collision) run in CI against the fakes.

### D14. Logging
Append-only JSON Lines in `$XDG_STATE_HOME/proton-drive-sync/audit.log`, rotated by size, with a `history <path>` command that filters by path or node UID. A separate debug log (levels) is optional and never contains secrets; a redaction layer strips known token shapes.

## Risks / Trade-offs

- [SDK is 0.x and may change its interfaces] -> Pin exact version; wrap the SDK behind our own `RemoteDrive` interface so upgrades touch one module; contract tests catch drift.
- [Porting login from the CLI drifts as Proton evolves auth] -> Keep the ported layer small and structurally identical to the CLI source so diffs against upstream are easy; document the upstream commit it was ported from.
- [inotify misses events (queue overflow, unwatched new dirs)] -> Full scan on startup and on a timer; overflow event forces a full scan; snapshot completeness gate blocks deletes on partial data.
- [Inode reuse misclassifies a new file as a move] -> Require digest match in addition to inode; on mismatch treat as delete plus create with delete safety rules.
- [SHA1 claim absent for some remote files (uploaded by other clients)] -> Compute local SHA1 after download and store as our own reference; mark "unverified against source" in the log.
- [Clock skew makes mtime unreliable] -> mtime is only a fast path; digests decide.
- [Large trees make full three-way reconciliation slow] -> SQLite-backed snapshots and indexed joins; reconcile only the changed subtree when both deltas are known and complete, full tree on scans. Correctness first, optimize after measurements.
- [Tray via dbusmenu is limited] -> Detailed views in a local web page; engine unaffected.
- [Bugs in the executor are the highest-impact failure] -> Non-destructive primitives (recycle, trash) mean even a wrong decision is reversible; brake limits blast radius; fault-injection tests are a release gate.
- [User runs the official CLI and this tool concurrently] -> Separate sessions; remote events reconcile changes made by the CLI like any other client.

## Migration Plan

Greenfield. Rollout order for the user's real account: (1) fake-only test suite green; (2) dry-run against a throwaway remote folder and empty local dir; (3) real sync of a throwaway folder; (4) dry-run against the real folder, review the audit log; (5) real sync with brake thresholds at their most conservative; (6) relax thresholds after a week of clean logs. Rollback: stop the process; all removed files are in recycle or Trash; state DB can be deleted to restart with first-sync protection.

## Open Questions

- Resolved at setup: `node:sqlite` is used (see D10). libsecret is accessed through the installed `secret-tool` binary (no native binding to build).
- Whether the SDK exposes a stable way to detect "cursor too old" versus generic refresh events; if not, fall back to periodic full listing at a fixed interval.
