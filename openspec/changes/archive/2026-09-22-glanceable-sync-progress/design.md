## Context

See proposal.md for why the bar and the tray disagree. The engine snapshot already has `pending` (uploads, downloads, other), set once when a plan is built and left unchanged until the cycle ends, plus `transfers` for the one or two files in flight. Nothing on that snapshot counts files finished in the run. The bar chip in `omarchy/Model.js` maps `state` to a single word and polls `status --json` every 2 seconds while scanning or syncing. The tray menu copies the first four `summaryLines` into a desktop menu that elides them, and `AboutToShow` returns false, so the shell may keep the previous layout.

## Goals / Non-Goals

**Goals:**

- One `progress` pair on the live snapshot that the chip, panel, tray, CLI, and details page can all read.
- A glance string `Sync (done/total)` or `Paused (done/total)` that updates as files complete.
- The tray menu rebuilt from the current snapshot when it opens.

**Non-Goals:**

- Byte progress inside one file. `done` moves per completed file.
- Changing what `pending` means. It stays the plan's original counts.
- Replacing pause, sync now, or the attention actions.

## Decisions

1. **`progress` is `{ done, total } | null` on `EngineStatus`.** `total` is the number of `upload` and `download` operations in the plan being executed. `done` starts at 0 and increments by one on `operation_completed` for those kinds. Proton documents never become download operations, so they are outside `total`. Moves, deletes, and folder operations are outside it too. `null` means there is no file run to show.

   Alternative: `localFiles / remoteFiles`. Rejected because Proton documents sit in the remote count and are never downloaded, so the fraction would stop short of the end on an otherwise finished library.

2. **Set and clear `progress` at cycle boundaries.** `cycleOnce` clears it at the start, so a scan does not keep the previous run's numbers. `executePlan` sets `{ done: 0, total }` only when the plan has at least one file transfer. `finishCycle` clears it when the cycle settles into idle, attention, or another resting state. Pause leaves it in place, including when `finishCycle` returns early because the state is already `paused`.

3. **The glance string is derived, not stored.** `Sync (${done}/${total})` when `state` is `syncing` and `total > 0`. `Paused (${done}/${total})` when `state` is `paused` and `total > 0`. Otherwise the existing one-word chip label. Attention still replaces the chip label with the attention presentation; the panel still leads with the glance string when `progress` is active so a held plan does not hide how far the run got.

4. **The panel stops repeating `summaryLines` as the progress readout.** Its first status text is the glance string when one exists, and the existing chip tooltip otherwise. In-flight transfers stay on the panel, where the text can wrap. The tray menu's status entry is only the glance string, or the short state line when there is no file run, plus the existing attention rows and actions. `AboutToShow` refreshes the menu model from `getStatus()` and returns true so the shell fetches that layout instead of reusing the last one.

5. **`summarize` puts the glance string first when it applies.** CLI status and the details page already render `summaryLines`, so they show the same line without a separate widget. The structured `progress` field is still on the JSON snapshot.

## Risks / Trade-offs

- [A large file holds `done` still until it completes] → Accepted. The in-flight transfer remains on the panel and the details page with byte progress.
- [A failed file does not increment `done`, so the fraction can stop short of `total`] → The run still leaves `syncing` when the cycle ends, and the chip then drops the fraction. Retryable failures stay in a later cycle rather than counting twice.
- [The bar sees progress only as often as it polls, every 2 seconds during a run] → That matches the existing "within a few seconds" bar requirement. The tray, which is pushed on each status event, moves on the completion itself.
- [Desktop menus that ignore `AboutToShow` can still cache a layout] → Returning true is the menu protocol's refresh signal. The chip poll does not depend on that menu.

## Migration Plan

No stored data changes. A running engine picks up `progress` on restart. Rollback is reverting the snapshot field and the label; older clients ignore an unknown JSON field, and a newer bar reading an older engine treats missing `progress` as no fraction.
