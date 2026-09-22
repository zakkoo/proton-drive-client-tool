## Purpose

Show Proton Drive sync in the Omarchy bar and let the user sign in, choose folders, and control the engine that is already running, without a second sync process.

## ADDED Requirements

### Requirement: Bar chip reflects engine state
The bar widget SHALL show a distinct state for each of: engine not installed, not signed in, not configured, and the engine states `starting`, `idle`, `scanning`, `syncing`, `paused`, `offline`, `throttled`, `attention`, `awaiting_confirmation`, `error`, `needs_login`, and `stopped`. The chip SHALL use the active bar's colors and type, and SHALL update within a few seconds of a state change. Attention (an unresolved conflict, a quarantined item, or a held plan) SHALL keep the chip in the attention presentation until the user has acted.

#### Scenario: Engine is syncing
- **WHEN** the running engine reports `syncing`
- **THEN** the chip shows the syncing presentation within a few seconds

#### Scenario: Something needs the user
- **WHEN** the engine reports a conflict, a quarantined item, or a held plan
- **THEN** the chip shows the attention presentation until that item is resolved or dismissed

#### Scenario: Engine is not installed
- **WHEN** the `proton-drive-sync` command is not available
- **THEN** the chip shows that the engine is not installed and does not report an engine state

### Requirement: Panel opens and closes from the bar
A left click on the chip SHALL toggle a panel anchored to the chip. Escape SHALL close the panel. The plugin SHALL NOT start a second Quickshell process.

#### Scenario: Click and Escape
- **WHEN** the user left-clicks the chip and then presses Escape
- **THEN** the panel opens and then closes

### Requirement: Panel shows status and does not invent a second sync policy
While the engine is running, the panel SHALL show the current state, the summary lines the engine already reports, in-flight transfers with direction and progress, and the counts of conflicts, quarantined items, and a held plan when one exists. Pause, resume, and sync-now SHALL send the same control actions as `proton-drive-sync pause`, `resume`, and `sync-now`. Confirming or rejecting a held plan, resolving a conflict with `keep_local`, `keep_remote`, or `keep_both`, and releasing a quarantine item SHALL send the same actions as the matching CLI commands. The panel SHALL also offer to open the sync folder and the existing local details page.

#### Scenario: Pause from the panel
- **WHEN** the user pauses from the panel
- **THEN** the engine enters the paused state and no further sync writes run until resume

#### Scenario: Held plan
- **WHEN** a plan is held
- **THEN** the panel lists the affected paths and offers confirm and reject, and neither action runs until the user chooses one

### Requirement: Sign-in and setup happen only when asked
Opening the panel SHALL NOT start a login and SHALL NOT write configuration. When no Proton session is stored, the panel SHALL offer Sign in, which runs `proton-drive-sync login` in a visible terminal. The panel SHALL NOT collect the Proton password itself. When the engine is not configured, the panel SHALL accept a local directory and a remote folder path and SHALL run `proton-drive-sync setup` only after the user confirms. A refused setup SHALL show the engine's error and SHALL leave the previous configuration unchanged.

#### Scenario: Opening the panel
- **WHEN** the user opens the panel and does nothing else
- **THEN** no login starts and no config file is written

#### Scenario: Sign in
- **WHEN** the user chooses Sign in
- **THEN** a visible terminal runs `proton-drive-sync login` and the password is entered there, not in the panel

#### Scenario: Setup refused
- **WHEN** the user confirms a setup the engine rejects
- **THEN** the panel shows the rejection and the stored sync pair is unchanged

### Requirement: The shell does not supervise a second engine
Enabling the plugin, loading the shell, or opening the panel SHALL NOT start `proton-drive-sync run`. The bar SHALL read status from the engine that is already running. When no engine is running, the panel SHALL say so and SHALL point at the documented way to start it. The plugin SHALL NOT stop that engine when the plugin is disabled or removed.

#### Scenario: Plugin enabled with nothing running
- **WHEN** the plugin is enabled and no engine process is running
- **THEN** no engine process is started by the plugin

#### Scenario: Engine already running
- **WHEN** an engine is already running and the plugin loads
- **THEN** the chip shows that engine's state and a second engine is not started

#### Scenario: Plugin removed
- **WHEN** the user removes the plugin while the engine is running
- **THEN** the bar chip disappears and the engine process keeps running
