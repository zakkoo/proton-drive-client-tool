# Tray Status Ui

## Purpose

A system tray presence that shows what the engine is doing, surfaces anything that needs the user's attention, and offers the few controls that matter.

## Requirements

### Requirement: Tray icon reflects engine state
The system SHALL show a tray icon whose appearance distinguishes at least: idle (in sync), scanning, syncing, paused, offline, throttled/degraded, needs attention (conflicts or quarantine), awaiting confirmation (brake), and error (including needs login). The tooltip SHALL use the same glance string as the bar chip when a file run is active: `Sync (done/total)` while files are transferring, and `Paused (done/total)` while that run is paused. The tooltip SHALL update when the finished count changes and SHALL NOT keep a previous run's text after the engine is idle.

#### Scenario: State change
- **WHEN** the engine changes state
- **THEN** the icon and its tooltip update within a few seconds

#### Scenario: File run
- **WHEN** the engine is syncing with 34 files finished of 5685
- **THEN** the tooltip contains `Sync (34/5685)`

#### Scenario: Attention required
- **WHEN** there is at least one unresolved conflict, quarantined item, or held plan
- **THEN** the icon shows the attention state until the user has acted

### Requirement: Status panel
Opening the tray SHALL show the live glance string when a file run is active (`Sync (done/total)` or `Paused (done/total)`), or the current state when no file-run total exists. The menu SHALL be built from the engine snapshot at the moment it is opened, so an earlier syncing story cannot remain after the engine is idle. The tray menu SHALL NOT use a clipped multi-line pending and file-count paragraph as the progress readout. In-flight file names are not required in the tray menu. The menu SHALL still show how many items need attention when that count is non-zero.

#### Scenario: Syncing
- **WHEN** the user opens the tray while 34 of 5685 files in the run are finished
- **THEN** the menu shows `Sync (34/5685)` from the current snapshot

#### Scenario: Opened after the run finished
- **WHEN** the tray menu previously showed a syncing story and the user opens it again after the engine is idle
- **THEN** the menu shows the idle state and does not show the previous finished and total counts

#### Scenario: Idle
- **WHEN** nothing is pending and the user opens the tray
- **THEN** the menu shows the in-sync state

### Requirement: Conflict inbox and quarantine views
The tray SHALL provide views listing unresolved conflicts and quarantined items, each with both versions' metadata and the reason, and SHALL offer the resolution actions defined by conflict handling and safety guards.

#### Scenario: Resolve from tray
- **WHEN** the user picks a resolution for a conflict in the tray
- **THEN** the resolution is handed to the engine and the item disappears from the inbox once executed

### Requirement: Held plan confirmation
When the engine is awaiting confirmation for a mass change, the tray SHALL show the list of items that would be deleted or replaced and SHALL offer "proceed" and "reject" actions.

#### Scenario: Review held plan
- **WHEN** a plan is held by the mass-change brake
- **THEN** the user can see every affected path before deciding

### Requirement: Controls
The tray SHALL offer pause/resume, "sync now", open sync folder, open recycle folder, open log, open settings, open details page, and quit. Quit SHALL stop the engine cleanly at an operation boundary. Pause SHALL set the engine to paused and SHALL prevent new sync operations until resume.

#### Scenario: Pause
- **WHEN** the user selects pause
- **THEN** the engine enters paused state, the icon reflects it, and no further uploads, downloads, moves, trash or recycle run until resume

#### Scenario: Quit during transfer
- **WHEN** the user quits while a transfer is running
- **THEN** the transfer is cleanly aborted or completed, the journal is consistent, and the process exits

### Requirement: Notifications for events needing attention
The system SHALL emit a desktop notification when a conflict is created, an item is quarantined, a plan is held, login is required, or the engine enters error state. Routine sync activity SHALL not produce notifications.

#### Scenario: New conflict
- **WHEN** a conflict is created
- **THEN** one notification is shown naming the file

### Requirement: Tray unavailable does not stop sync
If no tray host is available, the engine SHALL continue running and SHALL expose the same live snapshot through the command-line status command and, when started, through the details page.

#### Scenario: No tray host
- **WHEN** the desktop offers no tray
- **THEN** sync continues and the status command returns the same information the panel would show, including state, last successful sync, file counts, pending work, transfers and attention

### Requirement: Shared live snapshot
CLI status (human and JSON), the tray menu/tooltip, the bar chip, and the localhost detail page SHALL present the same live engine snapshot: state and reason, dry-run flag, last successful full sync time, last cycle time, counts of baseline / local files / remote files, pending uploads/downloads/other, file-run progress (`done` and `total`, or an empty progress when no file run is active), in-flight transfers (path, direction, bytes, total, speed), open conflicts, quarantined items, held plan (id, reason, affected paths), and recycle entries. None of those fields SHALL stay stuck at empty defaults while the engine has real values.

File-run `total` SHALL be the number of upload and download operations in the current plan. It SHALL NOT count files on disk against files on Proton, and it SHALL NOT include Proton documents or other operations that are not file transfers. `done` SHALL start at zero when that file work begins and SHALL increase by one as each of those files completes. Progress SHALL be empty while the engine is scanning before a file plan exists, when the plan contains no file transfers, and after the engine is idle. A paused file run SHALL keep the `done` and `total` from that run.

#### Scenario: Idle after a successful sync
- **WHEN** the engine has converged and the user opens CLI status, the tray, the bar, or the detail page
- **THEN** every surface shows in-sync (or idle), a last-successful-sync timestamp, matching non-zero file counts when files exist, and no file-run fraction

#### Scenario: Syncing
- **WHEN** at least one upload or download is in progress and the plan contains 5685 file transfers of which 34 have completed
- **THEN** every surface reports `done` 34 and `total` 5685, the tray and the bar show `Sync (34/5685)`, and the CLI and the detail page still list each in-flight transfer

#### Scenario: File completes
- **WHEN** one more file in that run completes
- **THEN** the snapshot's `done` count is 35 and the pending upload and download totals from the start of the plan are unchanged

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
