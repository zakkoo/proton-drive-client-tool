## Why

The status a person can see does not match what the engine is doing. The tray menu keeps an old paragraph ("Syncing", thousands of files still pending) after the engine has already gone idle, and the desktop clips those lines so they cannot be read. The bar chip beside it only says one word, `Sync` or `Drive`, so a long run looks the same as a stuck one. Someone glancing at the bar should see the run move.

## What Changes

- Report a run progress on the live engine snapshot: files finished in the current run, and files that run will touch. The finished count increases by one as each file completes. The total is the plan for this run, not "files on disk" over "files on Proton". Proton documents that are never downloaded are not part of the total.
- While that run is transferring files, the bar chip reads `Sync (done/total)`, for example `Sync (34/5685)`. The pair updates within a few seconds, so the first number climbs while work is happening.
- While the engine is still scanning and does not yet know the total, the chip keeps the scanning word and does not invent a fraction.
- When the run finishes and the engine is idle, the chip returns to the idle word. A finished library does not stay on screen as a fraction.
- A paused run keeps the fraction where it stopped, so a frozen number means paused rather than finished.
- The panel and the tray use that same one line as the status a person reads. Pause, resume, sync now, and the existing open and attention actions stay. The clipped multi-line essay stops being the way to tell whether sync is moving.
- Opening the tray shows the live snapshot. It cannot keep an earlier "Syncing" story after the engine has gone idle.

A single large file holds the same count until that file finishes. Byte progress inside one file is out of scope.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `omarchy-bar-status`: The chip shows run progress while a run is transferring files, the scanning word until the total is known, the idle word when the run is over, and the paused fraction when a run is paused. The panel leads with that same line.
- `tray-status-ui`: The shared live snapshot includes files finished and files planned for the current run, and the finished count increases as each file completes. The tray shows that live line when opened and does not keep a stale status.

## Impact

- Engine status consumed by `proton-drive-sync status`, the bar poller, the tray, and the details page. Existing pending upload and download counts stay; run progress is an additional pair.
- Bar chip label in `omarchy/Model.js` and `omarchy/BarWidget.qml`. The panel in `omarchy/Panel.qml` stops relying on the long summary lines as the progress readout.
- Tray menu and tooltip in `src/tray/`, which today render those summary lines and can keep a previous layout.
- Tests that lock the chip to one distinct word per engine state, and the tray/status snapshot tests that describe pending work and summary lines.
