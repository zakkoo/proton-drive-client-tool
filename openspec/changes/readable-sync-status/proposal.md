## Why

The status a person can read names one clock "Last full sync" and hides a file total that does not match either side. On the current library that line is `Files: 30617 local, 30624 remote (31151 synced)`. The 31151 is 30617 paired files plus 534 paired folders, and the 7 extra remote files are Proton documents that are never downloaded. The same line never says when the latest check finished or how many files that check copied.

## What Changes

- Show two times. **Last sync** is when the latest check finished, with how many files that check copied (uploads and downloads). Zero is shown as "no files copied", not omitted. **Last full sync** is when the whole Proton tree was last re-read (startup, the hourly listing, or a refresh the server asked for). Today the words "Last full sync" are attached to every successful check, including one that copies nothing, and the full-listing time is not shown.
- While a file run is in progress, the existing `Sync (done/total)` line stays the progress readout. The last-sync line keeps the previous finished check until this one finishes. A failed check does not replace that previous line.
- Replace the mixed file line with separate, labeled counts: files on this computer, files on Proton, files in sync (paired files only), folders in sync, and Proton documents that stay on Proton. Proton documents are named as Docs and Sheets that have no file to download. Other one-sided files, when any exist, get their own labeled count. The parenthetical that adds files and folders into one "synced" number goes away.
- The details page lists those Proton document paths. The tray, the bar panel, and `proton-drive-sync status` show the count and the reason, not the path list.
- The bar chip stays a short state word, or `Sync (done/total)` / `Paused (done/total)` during a file run. The explanation lives in the panel, the tray menu, the command, and the details page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tray-status-ui`: The shared snapshot distinguishes last sync (plus files copied) from last full sync, and the human status explains files, folders, and Proton documents separately. The tray menu and the details page show that reading when idle.
- `omarchy-bar-status`: The panel shows the same last-sync line and file breakdown. The chip does not grow into that paragraph.

## Impact

- Human summary lines from `summarize`, so CLI status, the tray, and the details page change wording together. The JSON fields `lastSuccessfulSyncAt` and `counts.baseline` stay (baseline remains every paired row, files and folders, for the mass-change brake). New snapshot fields carry the full-listing time, files copied in the last finished check, paired files, paired folders, and Proton documents.
- Engine cycle completion in `src/engine/engine.ts` must remember files copied after the run ends. Today that count is cleared when the engine returns to idle.
- Remote mirror full-listing time must be copied onto the live snapshot. It already exists on the mirror and is not reported.
- Tray menu and tooltip in `src/tray/`, the details page in `src/tray/detailPage.ts`, and the bar panel in `omarchy/Panel.qml`. The chip label in `omarchy/Model.js` stays short.
- Tests that lock the old `Files: N local, N remote (N synced)` line and the `Last full sync` label on every successful check.
