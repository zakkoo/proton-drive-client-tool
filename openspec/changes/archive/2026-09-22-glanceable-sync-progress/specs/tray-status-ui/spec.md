## MODIFIED Requirements

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
