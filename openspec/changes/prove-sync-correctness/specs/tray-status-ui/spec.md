## ADDED Requirements

### Requirement: Shared live snapshot
CLI status (human and JSON), the tray menu/tooltip, and the localhost detail page SHALL present the same live engine snapshot: state and reason, dry-run flag, last successful full sync time, last cycle time, counts of baseline / local files / remote files, pending uploads/downloads/other, in-flight transfers (path, direction, bytes, total, speed), open conflicts, quarantined items, held plan (id, reason, affected paths), and recycle entries. None of those fields SHALL stay stuck at empty defaults while the engine has real values.

#### Scenario: Idle after a successful sync
- **WHEN** the engine has converged and the user opens CLI status, the tray, or the detail page
- **THEN** every surface shows in-sync (or idle), a last-successful-sync timestamp, and matching non-zero file counts when files exist

#### Scenario: Syncing
- **WHEN** at least one upload or download is in progress
- **THEN** every surface lists that transfer with live progress, and pending counts are greater than zero until the cycle finishes

#### Scenario: Attention
- **WHEN** there is an open conflict, a quarantined item, or a held plan
- **THEN** every surface names those items; they are not omitted or shown as "none"

### Requirement: Detail page is a live view
The details page SHALL be served only on 127.0.0.1 behind a per-run secret in the URL, SHALL load the live snapshot into the visible page (not only into a JSON endpoint), SHALL refresh while open, and SHALL offer pause, resume, sync now, conflict resolution, quarantine release, and held-plan confirm/reject. A successful load of a running engine SHALL never render an empty shell with no state, counts, or lists when the engine has data.

#### Scenario: Open details with files already synced
- **WHEN** the user opens the details page after a successful sync of a non-empty tree
- **THEN** the visible page shows the engine state, last successful sync, file counts, and is not blank

#### Scenario: Pause from the page
- **WHEN** the user clicks Pause on the details page
- **THEN** the engine enters paused, the page's displayed state becomes paused, and subsequent local creates are not uploaded until Resume

#### Scenario: Unknown token
- **WHEN** a client requests the page or its API with a token that is not the current run's token
- **THEN** the server responds not found and does not leak status

### Requirement: Control actions reach the engine
Pause, resume, sync now, quit, confirm held plan, reject held plan, resolve conflict, and release quarantine SHALL change engine state when invoked from the tray menu, from the details page, from the CLI, or from the control socket. Selecting the labelled action SHALL NOT be a no-op.

#### Scenario: Pause from the tray menu
- **WHEN** the user activates the tray item "Pause syncing" while the engine is idle or syncing
- **THEN** the engine enters paused, further local and remote changes are not applied, and the tray icon/label reflect paused

#### Scenario: Resume from the CLI
- **WHEN** the engine is paused with a backlog and the user runs resume
- **THEN** the backlog is processed and the engine leaves paused

#### Scenario: Held plan from any surface
- **WHEN** a plan is held and the user confirms or rejects it from tray, page, CLI, or socket
- **THEN** confirm executes that plan and reject discards it without applying the held deletes or replacements

## MODIFIED Requirements

### Requirement: Status panel
Opening the tray SHALL show: current state and its reason, last successful full sync time, counts of baseline, local files and remote files, counts of pending uploads and downloads, the list of in-flight transfers with file name, direction, progress and speed, and the count of items needing attention.

#### Scenario: Syncing
- **WHEN** transfers are running
- **THEN** each transfer appears with live progress and the totals update as items complete

#### Scenario: Idle
- **WHEN** nothing is pending
- **THEN** the panel shows "in sync" with the time of the last successful cycle and the current file counts

### Requirement: Controls
The tray SHALL offer pause/resume, "sync now", open sync folder, open recycle folder, open log, open settings, open details page, and quit. Quit SHALL stop the engine cleanly at an operation boundary. Pause SHALL set the engine to paused and SHALL prevent new sync operations until resume.

#### Scenario: Pause
- **WHEN** the user selects pause
- **THEN** the engine enters paused state, the icon reflects it, and no further uploads, downloads, moves, trash or recycle run until resume

#### Scenario: Quit during transfer
- **WHEN** the user quits while a transfer is running
- **THEN** the transfer is cleanly aborted or completed, the journal is consistent, and the process exits

### Requirement: Tray unavailable does not stop sync
If no tray host is available, the engine SHALL continue running and SHALL expose the same live snapshot through the command-line status command and, when started, through the details page.

#### Scenario: No tray host
- **WHEN** the desktop offers no tray
- **THEN** sync continues and the status command returns the same information the panel would show, including state, last successful sync, file counts, pending work, transfers and attention
