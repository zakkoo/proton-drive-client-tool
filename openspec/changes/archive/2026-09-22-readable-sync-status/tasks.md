## 1. Snapshot and wording

- [x] 1.1 Add `lastFullSyncAt`, `lastRunFilesCopied`, `protonDocumentPaths`, and the library counts (`pairedFiles`, `pairedFolders`, `protonDocuments`, `onlyLocal`, `onlyRemote`) to `EngineStatus`, with `counts.baseline` still the paired-file plus paired-folder total. Leave the new clocks null and the new counts at 0 in `initialStatus`. Verify `src/engine/status.test.ts` covers a starting snapshot.
- [x] 1.2 Teach `summarize` the reading lines from the tray-status-ui spec: last sync with `no files copied`, `1 file copied`, or `N files copied`; last full sync; files, folders, and Proton documents; only-on-one-side lines only when non-zero. Omit the old `Files: N local, N remote (N synced)` line and do not print the baseline sum. Verify `src/engine/status.test.ts` for the 30617 / 30624 / 30617 / 534 / 7 case, a zero-copy check, a one-file check, singular only-on-one-side lines, and that a file-run glance still leads and a pending line still appears.

## 2. Engine clocks and counts

- [x] 2.1 Add a grouped baseline count by kind and verify `src/state/baseline.test.ts` returns file and folder totals that add up to `count()`.
- [x] 2.2 Copy `lastFullListingAt` onto `lastFullSyncAt` when status is read. On `finishCycle(true)`, set `lastRunFilesCopied` from file-run `done` before progress is cleared, or 0 when the plan copied nothing, and set `lastSuccessfulSyncAt` as today. A failed check, a held plan, and an early return leave both fields unchanged. Verify an engine test in `src/engine/engine.test.ts`: a check that copies files records that count, a later empty check records `no files copied` and does not move `lastFullSyncAt`, and a failed check keeps the previous last sync.
- [x] 2.3 Fill the library counts from paired rows, the local snapshot, and the remote mirror. Proton documents are non-trashed `isProtonDocument` files, included in `remoteFiles`, excluded from paired files and from `onlyRemote`, with paths sorted. Cache paired and remote paths across transfer-progress publishes and rebuild the cache at check start and check finish. Verify an engine test with one Proton document, one unpaired local file, one unpaired remote file, and one paired file missing locally: the files line, both only-on-one-side lines, the document path, and no `onlyRemote` credit for the missing paired file.

## 3. Tray and details page

- [x] 3.1 Show each reading line as its own disabled tray-menu row under the glance or state row, and use those lines in the idle tooltip. A file-run tooltip stays `Sync (done/total)` or `Paused (done/total)` only. Do not show `Pending:` lines or Proton document paths in the menu. Verify `src/tray/tray.test.ts` for an idle library menu, a syncing tooltip without the library lines, and an idle reopen that shows `12 files copied` and not `Sync (34/5685)`.
- [x] 3.2 Drop the `N local · N remote · N synced` header from the details page, show the summary lines, and list `protonDocumentPaths` in their own section. Verify `src/tray/detailView.test.ts` and `src/tray/detailPage.e2e.test.ts`: a tree with no Proton documents has no path list, and two document paths are visible on the page while human CLI status from `formatStatus` omits those paths.

## 4. Bar panel

- [x] 4.1 Add a reading-line helper in `omarchy/Model.js` that keeps summary lines with the reading prefixes and leaves the chip label on `chipModel`. Verify `src/cli/omarchyModel.test.ts`: idle with `Last sync` and `Proton documents` in the snapshot still labels the chip with the idle word, and the helper returns those lines and drops a `Pending:` line.
- [x] 4.2 Render those reading lines under the panel headline in `omarchy/Panel.qml`, without listing Proton document paths. Verify the panel source shows the helper output under the headline and does not format a second copy of the sentences.

## 5. Check

- [x] 5.1 Update `src/engine/statusSurfaces.e2e.test.ts` so a converged tree expects `Last sync` with a files-copied phrase and the new files line, not `Files: N local` or a baseline sum labeled synced. Run the status, engine, tray, detail-page, and bar-model tests and confirm they pass.
