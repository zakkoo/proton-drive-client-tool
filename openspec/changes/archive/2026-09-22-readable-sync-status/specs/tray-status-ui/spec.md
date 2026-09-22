## MODIFIED Requirements

### Requirement: Tray icon reflects engine state
The system SHALL show a tray icon whose appearance distinguishes at least: idle (in sync), scanning, syncing, paused, offline, throttled/degraded, needs attention (conflicts or quarantine), awaiting confirmation (brake), and error (including needs login). The tooltip SHALL use the same glance string as the bar chip when a file run is active: `Sync (done/total)` while files are transferring, and `Paused (done/total)` while that run is paused. The tooltip SHALL update when the finished count changes and SHALL NOT keep a previous run's text after the engine is idle. When no file run is active, the tooltip SHALL include the same last-sync, last-full-sync, and library lines the human status shows, and SHALL NOT include a `Sync (done/total)` or `Paused (done/total)` fraction.

#### Scenario: State change
- **WHEN** the engine changes state
- **THEN** the icon and its tooltip update within a few seconds

#### Scenario: File run
- **WHEN** the engine is syncing with 34 files finished of 5685
- **THEN** the tooltip contains `Sync (34/5685)` and does not contain the library lines

#### Scenario: Idle tooltip
- **WHEN** the engine is idle after a check that copied 2 files, and the library has files
- **THEN** the tooltip contains `Last sync:` and `2 files copied`, contains `Files:`, and does not contain a `Sync (` fraction

#### Scenario: Attention required
- **WHEN** there is at least one unresolved conflict, quarantined item, or held plan
- **THEN** the icon shows the attention state until the user has acted

### Requirement: Status panel
Opening the tray SHALL show the live glance string when a file run is active (`Sync (done/total)` or `Paused (done/total)`), or the current state when no file-run total exists. The menu SHALL be built from the engine snapshot at the moment it is opened, so an earlier syncing story cannot remain after the engine is idle. The tray menu SHALL NOT use a clipped multi-line pending and file-count paragraph as the progress readout. In-flight file names are not required in the tray menu. The menu SHALL still show how many items need attention when that count is non-zero. When the human status has last-sync, last-full-sync, or library lines, the menu SHALL show each of those lines as its own readable entry, and SHALL NOT list individual Proton document paths.

#### Scenario: Syncing
- **WHEN** the user opens the tray while 34 of 5685 files in the run are finished
- **THEN** the menu shows `Sync (34/5685)` from the current snapshot

#### Scenario: Opened after the run finished
- **WHEN** the tray menu previously showed a syncing story and the user opens it again after the engine is idle and that check copied 12 files
- **THEN** the menu shows the idle state and `Last sync:` with `12 files copied`, and does not show `Sync (34/5685)`

#### Scenario: Idle
- **WHEN** nothing is pending and the user opens the tray
- **THEN** the menu shows the in-sync state

#### Scenario: Library reading in the menu
- **WHEN** the user opens the tray while the human status contains a files line, a folders line, and a Proton documents line
- **THEN** the menu shows each of those three lines and does not show a Proton document path

### Requirement: Shared live snapshot
CLI status (human and JSON), the tray menu/tooltip, the bar chip, and the localhost detail page SHALL present the same live engine snapshot: state and reason, dry-run flag, last successful sync time, files copied in that sync, last full sync time, last cycle time, counts of baseline rows, local files, remote files, paired files, paired folders, Proton documents, files only on this computer, and non-document files only on Proton, the relative paths of those Proton documents, pending uploads/downloads/other, file-run progress (`done` and `total`, or an empty progress when no file run is active), in-flight transfers (path, direction, bytes, total, speed), open conflicts, quarantined items, held plan (id, reason, affected paths), and recycle entries. None of those fields SHALL stay stuck at empty defaults while the engine has real values.

`lastSuccessfulSyncAt` SHALL be the time the latest check finished without error. `lastRunFilesCopied` SHALL be the number of upload and download operations that completed in that check. A check that finishes without copying a file SHALL set `lastRunFilesCopied` to 0 and SHALL still update `lastSuccessfulSyncAt`. A check that fails, is held for confirmation, or is still running SHALL leave both fields at the previous finished check. `lastFullSyncAt` SHALL be the time the whole Proton tree was last re-read, which happens at startup, on the periodic full listing, and when the server asks for a full refresh. A small check after one change SHALL NOT move `lastFullSyncAt`.

The baseline count SHALL remain the number of paired files plus paired folders. Human status SHALL NOT display that sum, and SHALL NOT contain a line of the form `Files: <n> local, <n> remote (<n> synced)`.

Human status SHALL use these lines, omitting a line whose count does not apply. Timestamps SHALL be ISO-8601 from the same instant the snapshot stores. `1 file copied` and `1 file` SHALL be singular; every larger count SHALL be plural.

- `Last sync: <time>, no files copied` when `lastRunFilesCopied` is 0
- `Last sync: <time>, 1 file copied` when `lastRunFilesCopied` is 1
- `Last sync: <time>, <n> files copied` when `lastRunFilesCopied` is greater than 1
- `Last full sync: <time>` when `lastFullSyncAt` is set
- `Files: <local> on this computer, <remote> on Proton, <paired> in sync` when any of those three counts is non-zero
- `Folders: <n> in sync` when paired folders are non-zero
- `Proton documents: 1 on Proton only (Docs and Sheets stay in the browser)` when there is one Proton document
- `Proton documents: <n> on Proton only (Docs and Sheets stay in the browser)` when there is more than one
- `Only on this computer: 1 file` or `Only on this computer: <n> files` when that count is non-zero
- `Only on Proton: 1 file` or `Only on Proton: <n> files` when that count is non-zero

Files on this computer SHALL be local files in the sync folder. Files on Proton SHALL be remote files that are not in the trash, including Proton documents. Files in sync SHALL be paired files only, not folders. Proton documents SHALL be remote Docs, Sheets, and similar items that have no file to download. They SHALL count inside files on Proton, SHALL NOT count as files in sync, and SHALL NOT count as files only on Proton. Files only on this computer SHALL be local files that are not paired. Files only on Proton SHALL be remote files that are not paired and are not Proton documents. A paired file that is missing on one side SHALL change the files line and SHALL NOT be added to either only-on-one-side count.

File-run `total` SHALL be the number of upload and download operations in the current plan. It SHALL NOT count files on disk against files on Proton, and it SHALL NOT include Proton documents or other operations that are not file transfers. `done` SHALL start at zero when that file work begins and SHALL increase by one as each of those files completes. Progress SHALL be empty while the engine is scanning before a file plan exists, when the plan contains no file transfers, and after the engine is idle. A paused file run SHALL keep the `done` and `total` from that run. The last-sync line SHALL keep the previous finished check until the current run finishes without error.

#### Scenario: Idle after a successful sync
- **WHEN** the engine has converged after copying 2 files, with 2 local files, 2 remote files, 2 paired files, and no Proton documents
- **THEN** human status shows in-sync, `Last sync:` with `2 files copied`, `Files: 2 on this computer, 2 on Proton, 2 in sync`, and no file-run fraction, no Proton documents line, and no `(2 synced)`

#### Scenario: Check copies nothing
- **WHEN** a check finishes without error and copies no files, and an older full re-read is already recorded
- **THEN** `Last sync` shows that check's time and `no files copied`, and `Last full sync` stays at the older re-read

#### Scenario: Full re-read
- **WHEN** the periodic full listing completes and the check that follows copies no files
- **THEN** `Last full sync` and `Last sync` both show that listing's check, and a later one-file check moves `Last sync` and `lastRunFilesCopied` to 1 without moving `Last full sync`

#### Scenario: Failed check keeps the previous sync
- **WHEN** the latest finished check copied 2 files and a later check fails
- **THEN** human status still shows `2 files copied` from the earlier check

#### Scenario: Library with Proton documents and folders
- **WHEN** the snapshot has 30617 local files, 30624 remote files, 30617 paired files, 534 paired folders, 7 Proton documents, and no only-on-one-side files
- **THEN** human status contains `Files: 30617 on this computer, 30624 on Proton, 30617 in sync`, `Folders: 534 in sync`, and `Proton documents: 7 on Proton only (Docs and Sheets stay in the browser)`, and does not contain `31151` or `synced)`

#### Scenario: One-sided files
- **WHEN** 1 local file is not paired and 2 remote files are neither paired nor Proton documents
- **THEN** human status contains `Only on this computer: 1 file` and `Only on Proton: 2 files`

#### Scenario: Paired file missing on one side
- **WHEN** 1 paired file is absent from the local snapshot and is still paired
- **THEN** the files line shows one fewer file on this computer than files in sync, and that file is not counted as only on Proton

#### Scenario: Syncing
- **WHEN** at least one upload or download is in progress and the plan contains 5685 file transfers of which 34 have completed, and the previous finished check copied 2 files
- **THEN** every surface reports `done` 34 and `total` 5685, the tray and the bar show `Sync (34/5685)`, the last-sync line still says `2 files copied`, and the CLI and the detail page still list each in-flight transfer

#### Scenario: File completes
- **WHEN** one more file in that run completes
- **THEN** the snapshot's `done` count is 35 and the pending upload and download totals from the start of the plan are unchanged

#### Scenario: Attention
- **WHEN** there is an open conflict, a quarantined item, or a held plan
- **THEN** every surface names those items; they are not omitted or shown as "none"

### Requirement: Detail page is a live view
The details page SHALL be served only on 127.0.0.1 behind a per-run secret in the URL, SHALL load the live snapshot into the visible page (not only into a JSON endpoint), SHALL refresh while open, and SHALL offer pause, resume, sync now, conflict resolution, quarantine release, and held-plan confirm/reject. A successful load of a running engine SHALL never render an empty shell with no state, counts, or lists when the engine has data. The visible page SHALL show the human last-sync, last-full-sync, and library lines, and SHALL NOT show `N local · N remote · N synced`. When Proton documents exist, the page SHALL list each of their relative paths. The tray, the bar panel, and human CLI status SHALL NOT list those paths.

#### Scenario: Open details with files already synced
- **WHEN** the user opens the details page after a successful sync of a non-empty tree with no Proton documents
- **THEN** the visible page shows the engine state, a `Last sync` line, a files line, and is not blank, and it does not show a Proton document path

#### Scenario: Proton documents are listed
- **WHEN** the snapshot includes two Proton documents at `Notes/Agenda` and `Notes/Budget`
- **THEN** the details page shows both paths, and human CLI status shows the Proton documents count without either path

#### Scenario: Pause from the page
- **WHEN** the user clicks Pause on the details page
- **THEN** the engine enters paused, the page's displayed state becomes paused, and subsequent local creates are not uploaded until Resume

#### Scenario: Unknown token
- **WHEN** a client requests the page or its API with a token that is not the current run's token
- **THEN** the server responds not found and does not leak status
