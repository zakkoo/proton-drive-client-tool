## MODIFIED Requirements

### Requirement: Bar chip reflects engine state
The bar widget SHALL show a distinct state for each of: engine not installed, not signed in, not configured, and the engine states `starting`, `idle`, `scanning`, `syncing`, `paused`, `offline`, `throttled`, `attention`, `awaiting_confirmation`, `error`, `needs_login`, and `stopped`. The chip SHALL use the active bar's colors and type, and SHALL update within a few seconds of a state change. Attention (an unresolved conflict, a quarantined item, or a held plan) SHALL keep the chip in the attention presentation until the user has acted.

While the engine is `syncing` and the live snapshot has a file-run total greater than zero, the chip label SHALL be `Sync (done/total)` using that snapshot's finished and planned file counts. While the engine is `paused` and that total is greater than zero, the chip label SHALL be `Paused (done/total)` and SHALL keep the counts from the moment the run was paused. While the engine is `scanning`, the chip SHALL keep the scanning word and SHALL NOT show a fraction. While the engine is `syncing` without a file-run total, the chip SHALL keep the syncing word and SHALL NOT show a fraction. While the engine is `idle`, the chip SHALL show the idle word and SHALL NOT show a fraction. The finished count on the chip SHALL increase within a few seconds of a file in the run completing. The chip label SHALL NOT contain `Last sync`, `Last full sync`, `Files:`, `Folders:`, or `Proton documents`.

#### Scenario: Engine is syncing
- **WHEN** the running engine reports `syncing` with 34 files finished of 5685 files in the run
- **THEN** the chip label is `Sync (34/5685)` within a few seconds

#### Scenario: Finished count climbs
- **WHEN** the chip shows `Sync (34/5685)` and one more file in that run completes
- **THEN** the chip label becomes `Sync (35/5685)` within a few seconds

#### Scenario: Scanning before a total exists
- **WHEN** the engine is scanning and has not yet reported a file-run total
- **THEN** the chip shows the scanning word and does not show a fraction

#### Scenario: Run finished
- **WHEN** the engine returns to `idle` after a file run
- **THEN** the chip shows the idle word and does not show a fraction

#### Scenario: Paused during a file run
- **WHEN** the user pauses while the snapshot reports 34 files finished of 5685
- **THEN** the chip label is `Paused (34/5685)` and those numbers stay until the run resumes or ends

#### Scenario: Something needs the user
- **WHEN** the engine reports a conflict, a quarantined item, or a held plan
- **THEN** the chip shows the attention presentation until that item is resolved or dismissed

#### Scenario: Engine is not installed
- **WHEN** the `proton-drive-sync` command is not available
- **THEN** the chip shows that the engine is not installed and does not report an engine state

#### Scenario: Idle library stays off the chip
- **WHEN** the engine is idle and human status contains `Last sync` and `Proton documents`
- **THEN** the chip label is the idle word and does not contain those lines

### Requirement: Panel shows status and does not invent a second sync policy
While the engine is running, the panel SHALL lead with the same glance string the chip uses for the current file run: `Sync (done/total)` while syncing with a file-run total, and `Paused (done/total)` while paused with a file-run total. That line SHALL update within a few seconds as files complete. The panel SHALL NOT use the multi-line pending and file-count paragraph as the way to see whether the run is moving. Below that leading line, the panel SHALL show the same last-sync, last-full-sync, and library lines as human CLI status, including a Proton documents line when those documents exist, and SHALL NOT list Proton document paths. The panel SHALL still show in-flight transfers with direction and progress, and the counts of conflicts, quarantined items, and a held plan when one exists. Pause, resume, and sync-now SHALL send the same control actions as `proton-drive-sync pause`, `resume`, and `sync-now`. Confirming or rejecting a held plan, resolving a conflict with `keep_local`, `keep_remote`, or `keep_both`, and releasing a quarantine item SHALL send the same actions as the matching CLI commands. The panel SHALL also offer to open the sync folder and the existing local details page.

#### Scenario: Syncing
- **WHEN** the engine is syncing with 34 files finished of 5685
- **THEN** the panel's leading status text is `Sync (34/5685)`

#### Scenario: Idle library
- **WHEN** the engine is idle and human status contains `Last sync:`, `Files: 30617 on this computer, 30624 on Proton, 30617 in sync`, and `Proton documents: 7 on Proton only (Docs and Sheets stay in the browser)`
- **THEN** the panel shows those three lines under the idle headline and does not show a Proton document path or `31151`

#### Scenario: Pause from the panel
- **WHEN** the user pauses from the panel
- **THEN** the engine enters the paused state and no further sync writes run until resume

#### Scenario: Held plan
- **WHEN** a plan is held
- **THEN** the panel lists the affected paths and offers confirm and reject, and neither action runs until the user chooses one
