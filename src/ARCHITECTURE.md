# Architecture

One process, one sync pair. Correctness under crash, network loss and concurrent edits
beats speed. See `openspec/changes/proton-drive-sync/design.md` for the decisions.

```
  +-----------------+     +------------------+
  | local/          |     | remote/          |
  | inotify + scan  |     | SDK subscribe +  |
  |                 |     | periodic listing |
  +--------+--------+     +---------+--------+
           |  local snapshot deltas   |  remote snapshot deltas
           v                          v
  +------------------------------------------------+
  |  state/   (SQLite)                             |
  |   local_nodes | remote_nodes | baseline        |
  |   journal | cursors | quarantine | conflicts   |
  +----------------------+-------------------------+
                         | (baseline, local, remote)
                         v
  +------------------------------------------------+
  |  reconcile/  (pure, no I/O)  -> Plan           |
  +----------------------+-------------------------+
                         | Plan
                         v
  +------------------------------------------------+
  |  safety/  preflight, brake, first-sync         |
  |  conflict/ classification and resolution       |
  +----------------------+-------------------------+
                         | approved Plan
                         v
  +------------------------------------------------+
  |  execute/  journal -> precheck -> do ->        |
  |            verify -> commit baseline           |
  +----------------------+-------------------------+
                         | status events (engine/)
                         v
  +------------------+   +------------------------+
  | tray/ (SNI/DBus) |   | cli/ status, audit/    |
  +------------------+   +------------------------+
```

## Modules

| Module       | Responsibility                                                                  |
|--------------|---------------------------------------------------------------------------------|
| `remote/`    | Proton auth, HTTP client, `RemoteDrive` interface over the SDK, event stream    |
| `local/`     | Full scan, inotify watcher, move detection, ignore rules, root checks           |
| `state/`     | SQLite store: baseline, snapshots, journal, cursors, quarantine, conflicts      |
| `reconcile/` | Pure three-way decision engine producing an ordered `Plan`                      |
| `safety/`    | Recycle directory, mass-change brake, first-sync protection, preflight, quarantine |
| `conflict/`  | Conflict naming, delete-vs-edit and structural conflicts, inbox and resolution  |
| `execute/`   | Journaled, verified, crash-recoverable execution of a `Plan`                    |
| `audit/`     | Append-only JSON Lines audit log, redaction, per-file history                   |
| `engine/`    | Cycle scheduler, state machine, status object, Unix-socket control protocol     |
| `tray/`      | StatusNotifierItem tray, notifications, local detail page                       |
| `config/`    | Config file schema and validation, secret store adapter                         |
| `cli/`       | Command-line entry point and commands                                           |
| `testing/`   | Fakes (remote, filesystem), fault-injection harness; excluded from the build    |

## Invariants

1. No code path permanently deletes user data. `deleteNodes` and `emptyTrash` are lint errors.
2. The baseline is written only after the destination side has been verified by digest.
3. Every mutation is journaled before it starts and resolved on the next startup before any new work.
4. Reconciliation performs no I/O and is deterministic for identical inputs.
