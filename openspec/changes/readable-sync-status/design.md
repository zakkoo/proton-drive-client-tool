## Context

See proposal.md for why the current line cannot be read. The live snapshot already has `lastSuccessfulSyncAt` (set in `finishCycle` on every successful check, including one that copies nothing), `lastCycleAt` (set when a check starts, not shown), and `progress` (cleared when the check returns to idle). `RemoteMirror.lastFullListingAt` records a full re-read and is not copied onto the snapshot. `summarize` prints `lastSuccessfulSyncAt` as `Last full sync` and prints `Files: <local> local, <remote> remote (<baseline> synced)`.

`computeCounts` sets `localFiles` from snapshot entries of kind `file`, `remoteFiles` from every non-trashed remote file (Proton documents included), and `baseline` from `COUNT(*)` of paired files and folders. On the current library that is 30617 files, 534 folders, and 31151 rows. The audit log for the latest check blocks exactly 7 Proton documents, which is `30624 - 30617`.

## Goals / Non-Goals

**Goals:**

- One human reading, produced next to the existing glance line, shared by CLI status, the tray, the details page, and the bar panel.
- Snapshot fields for the full-listing time, files copied in the last finished check, and the library split, without removing `counts.baseline` or changing what `lastSuccessfulSyncAt` means.
- Library counts that stay cheap when status is published once per completed file.

**Non-Goals:**

- Downloading, exporting, or ignoring Proton documents. They stay blocked.
- Persisting the two clocks across a restart. Both live on the in-memory snapshot, as `lastSuccessfulSyncAt` already does.
- Putting the reading on the bar chip, or listing Proton document paths in the tray, the panel, or human CLI status.
- Counting renames, deletes, or folder operations as files copied.

## Decisions

1. **Keep `lastSuccessfulSyncAt` as the last successful check, and stop calling it a full sync.** Human text becomes `Last sync: <ISO>, <n> files copied`, `1 file copied`, or `no files copied`. `lastFullSyncAt` is new and is copied from `mirror.lastFullListingAt` whenever status is read, so a listing that has finished is visible even if the follow-up check has not. JSON keeps the old field name so existing readers of `lastSuccessfulSyncAt` still see the last successful check.

   Alternative: store a second "last time files were copied" and leave the label `Last full sync` on every check. Rejected because the label would still be false, and a check that copies nothing would have no time of its own.

2. **`lastRunFilesCopied` is uploads and downloads that completed in the check `finishCycle(true)` closes.** An empty plan writes 0. The number is taken from file-run `done` before `finishCycle` clears `progress`. `finishCycle(false)`, a held plan, and a check that returns early (paused, no snapshot, remote unavailable) do not change `lastSuccessfulSyncAt` or `lastRunFilesCopied`. While a run is in progress, `progress` stays the live fraction and the last-sync line stays on the previous check.

   Alternative: count every completed operation, including baseline updates and moves. Rejected because a quiet check would report thousands of bookkeeping writes as files touched.

3. **Library counts are a split, not a new sum.** `computeCounts` gains `pairedFiles`, `pairedFolders`, `protonDocuments`, `onlyLocal`, `onlyRemote`, and the snapshot gains `protonDocumentPaths` sorted by relative path. `counts.baseline` stays `pairedFiles + pairedFolders` for the mass-change brake and for JSON. `summarize` never prints that sum. Proton documents are non-trashed remote files with `isProtonDocument`. They sit inside `remoteFiles`, outside paired files, and outside `onlyRemote`. `onlyLocal` is a local file path with no paired file row. `onlyRemote` is a non-document remote file path with no paired file row. A paired file missing on one side changes the files line only.

   `BaselineRepo` gains a grouped count by kind. Proton documents are a pass over the in-memory mirror, not a query. Paired paths and remote paths are cached on the engine and rebuilt when a check starts and when it finishes, not on transfer-progress publishes. A 5685-file run publishes status once per completion; walking the baseline on each of those publishes is the cost this cache avoids.

   Alternative: subtract the totals (`remote - paired - proton documents`) and skip paths. Rejected because a paired file missing on one side would be reported as an extra file on the other side.

4. **`summarize` is the only wording.** CLI `formatStatus` already prints `summaryLines`. The tray menu keeps its first row as the glance string or the state, then adds one disabled row per reading line (`Last sync`, `Last full sync`, `Files:`, `Folders:`, `Proton documents:`, `Only on this computer:`, `Only on Proton:`). It still omits `Pending:` and transfer-count lines. An idle tooltip uses those reading lines; a file-run tooltip stays the glance string alone. The details page drops the `N local · N remote · N synced` header, shows `summaryLines`, and lists `protonDocumentPaths` in its own section. `omarchy/Model.js` exposes the reading lines by those prefixes, and `Panel.qml` renders them under the headline. The chip path in `chipModel` is unchanged apart from tests that lock the label away from this paragraph.

   Alternative: format the sentences again in QML from the numeric fields. Rejected because the panel would drift from CLI status.

## Risks / Trade-offs

- [After this change, `Last full sync` can be older than the timestamp people see today] → The old label was the last successful check. That clock moves to `Last sync`. The proposal states this so the review can reject it before implementation.
- [A restart shows neither time until the next successful check] → Same as today's in-memory `lastSuccessfulSyncAt`. No database migration.
- [A held plan can copy some safe files without moving `Last sync`] → The state already says confirmation is required. `Last sync` moves when a check finishes without error.
- [A rename-only check says `no files copied`] → The number is files copied, which matches uploads and downloads. The audit log still records the rename.
- [The path cache is stale if the baseline changes outside a check] → Rebuild at check start and check finish, which are the baseline writers during a run. Status between those points is the last finished library.
- [A Proton document row left in the baseline from an older bug would count as a paired file and as a Proton document] → Current data has none. This change does not repair baseline rows.

## Migration Plan

No schema change. A running engine picks up the new fields on restart. Rollback is reverting the snapshot fields and the sentences. Older clients ignore unknown JSON fields. A newer panel reading an older engine shows no reading lines when those prefixes are absent, and the chip stays the short label.
