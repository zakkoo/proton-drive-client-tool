## Why

Proton offers no Linux desktop sync client, so files in Proton Drive and files on this machine drift apart and every change has to be pushed or pulled by hand. The official Proton Drive SDK for TypeScript (`@protontech/drive-sdk`, the same library behind the installed `proton-drive` CLI) is now mature enough to expose stable node IDs, per-file SHA1 digests, revision history and a remote change stream, which are the exact primitives a *safe* two-way sync engine needs. Building on it now avoids the reverse-engineered protocol layer that made the earlier Go attempt fragile.

The overriding requirement is data safety. The tool must never destroy or silently alter user data, even under crashes, network failures, clock skew, or bugs in its own logic. Every design choice is subordinate to that.

## What Changes

- New TypeScript application that keeps one local directory and one Proton Drive folder (default `/my-files`) in two-way sync.
- Initial sync: download the remote tree to the local directory (or reconcile an existing local directory) and record a baseline.
- Continuous sync: create, modify, rename, move and delete of files and folders on either side is mirrored to the other. Renames and moves are detected as such via stable node IDs and local inode tracking, never as delete-plus-create.
- Local file-system watcher (inotify) plus periodic reconciliation scan; remote changes consumed from the SDK event stream plus periodic full listing as a safety net.
- Persistent SQLite state database recording the last known state of every synced item on both sides, so every decision is a three-way comparison (baseline, local now, remote now).
- Write-ahead operation journal: every mutating operation is recorded before execution and completed or rolled forward after a crash. No half-applied state is ever left behind.
- Non-destructive deletes only: remote deletes go to Proton Trash, local deletes go to a local recycle directory with retention. The tool never permanently deletes on either side.
- Content verification: SHA1 checked after every download and upload before the state database is updated. Downloads are written to a temp file and atomically renamed into place.
- Conflict handling: when both sides changed the same item, both versions are kept with a clear suffix and the conflict is surfaced for the user to decide. The tool never picks a winner by overwriting.
- Safety brakes: a pass that would delete or replace more than a configured count or percentage of items halts and requires explicit confirmation. Suspicious situations (hash mismatch, unreadable local file, sync root disappeared, remote tree empty) pause the engine rather than propagate.
- Dry-run mode and a human-readable audit log of every action taken, available from day one.
- System tray application showing engine state (idle, scanning, syncing, paused, offline, error, awaiting confirmation), live transfer list with progress, pending up/down counts, last successful sync time, a conflict inbox, a quarantine view for items the engine refused to touch, and pause/resume, open-folder and open-log actions.
- Engine designed as a library with a thin in-process tray front-end so it can later be split into a headless daemon plus separate tray client without rewriting the engine.

## Capabilities

### New Capabilities

- `remote-drive-access`: Authenticating to Proton and reading/writing the Drive tree through the official SDK: listing, node metadata with stable IDs and digests, download, upload/new revision, rename, move, trash, and consuming the remote change event stream.
- `local-filesystem-watch`: Observing the local sync root for create, modify, rename, move and delete events, with periodic full scans, inode-based move detection, and ignore rules.
- `sync-state-store`: Persistent SQLite record of the baseline state of every item on both sides, the mapping between local paths, inodes and remote node IDs, and remote event cursors.
- `sync-reconciliation`: The pure, side-effect-free decision engine that takes baseline, local and remote snapshots and produces a plan of operations, including rename/move detection and conflict classification.
- `sync-execution`: Journaled execution of a plan with atomic writes, post-transfer hash verification, retries, resumable operations after crash, and rollback rules.
- `data-safety-guards`: Non-destructive delete (Trash and local recycle with retention), mass-change brakes, quarantine of suspicious items, and dry-run mode.
- `conflict-handling`: Preserving both versions when the same item changed on both sides, naming rules, and surfacing conflicts for user resolution.
- `audit-logging`: Structured, append-only log of every decision and action with enough detail to reconstruct what happened to any file.
- `tray-status-ui`: System tray presence with live status, transfer list, conflict inbox, quarantine view, and pause/resume, open-folder, open-log controls.
- `sync-configuration`: Configuration of sync root, remote folder, ignore patterns, retention, safety thresholds, and credentials storage in the OS keyring.

### Modified Capabilities

None. This is a greenfield project with no existing specs.

## Impact

- New codebase: TypeScript on Node.js (Bun considered; Node chosen for ecosystem stability of inotify and SQLite bindings). Key dependencies: `@protontech/drive-sdk`, an OpenPGP and SRP implementation compatible with the SDK's module interfaces, `better-sqlite3` or `node:sqlite`, a file watcher library, and a tray library.
- Open question to resolve in design: the SDK does not ship the login layer (SRP authentication, key unlocking). Must be implemented or borrowed from Proton's open-source clients. If this proves infeasible, the fallback is to use the installed `proton-drive` CLI for authentication only and hand its session to the SDK.
- Runs as a user-level process on Linux (Arch, Hyprland). Tray integration via StatusNotifierItem/AppIndicator.
- Touches user data on disk and in Proton Drive. Requires extensive table-driven tests of the reconciliation engine, integration tests against a fake remote, and crash-injection tests of the journal before any real account is used.
- No changes to existing systems; the installed CLI remains untouched.
