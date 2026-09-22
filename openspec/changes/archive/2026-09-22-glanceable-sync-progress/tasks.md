## 1. Engine snapshot

- [x] 1.1 Add `progress: { done, total } | null` to the engine status, leave it null initially, and make `summarize` lead with `Sync (done/total)` or `Paused (done/total)` when that pair is active. Verify `src/engine/status.test.ts` covers the glance line, an idle status with no fraction, and that existing pending lines stay.
- [x] 1.2 Clear progress at the start of a cycle, set `{ done: 0, total }` from the plan's upload and download count when file execution starts, increment `done` once per completed file transfer, and clear it again when the cycle settles without staying paused. Verify an engine test shows the count climb on completion and return to null when the run is idle.

## 2. Bar

- [x] 2.1 Make the chip label `Sync (done/total)` while syncing with a file total, `Paused (done/total)` while paused with one, the scanning word with no fraction before a total exists, and the idle word with no fraction when idle. Attention still replaces the chip label. Verify `src/cli/omarchyModel.test.ts`.
- [x] 2.2 Make the panel's leading status the same glance string, and stop repeating the summary-line paragraph as the progress readout. In-flight transfers and the existing actions stay. Verify `omarchy/Panel.qml` leads with that string and no longer repeats `summaryLines`.

## 3. Tray

- [x] 3.1 Make the tray menu status the glance string, or the short state when no file run is active, and refresh that menu from the current snapshot when it is about to open. Verify the tray model and menu-refresh tests show `Sync (done/total)` while syncing and the idle state, not the previous fraction, after the run ends.

## 4. Check

- [x] 4.1 Run the status, engine, tray, and bar-model tests and confirm they pass.
