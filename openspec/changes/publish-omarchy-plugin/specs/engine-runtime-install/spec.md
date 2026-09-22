## Purpose

Install and remove the Node sync engine outside the Omarchy plugin checkout, and optionally start it as a user service, without deleting the user's files or rewriting configuration they already have.

## ADDED Requirements

### Requirement: The engine is installed only by an explicit command
`omarchy plugin add`, enabling the plugin, and loading the shell SHALL NOT install packages, build the engine, or write a systemd unit. The user-facing install command SHALL be:

`~/.config/omarchy/plugins/io.github.zakkoo.proton-drive/scripts/install-engine`

Passing `--service` to that command is the only way this change enables the background service.

#### Scenario: Plugin add alone
- **WHEN** the user runs `omarchy plugin add` and enables the plugin, and does not run the install command
- **THEN** no engine runtime is built and no systemd unit is written

### Requirement: Runtime lives outside the plugin directory
A successful install SHALL build the engine from this repository's lockfile into `$XDG_DATA_HOME/proton-drive-sync/runtime`, or `~/.local/share/proton-drive-sync/runtime` when `XDG_DATA_HOME` is unset. It SHALL expose `proton-drive-sync` as `~/.local/bin/proton-drive-sync` when that path is absent or already points at this runtime. It SHALL NOT create `node_modules`, build output, or any symlink inside the plugin directory. It SHALL NOT pipe a download into a shell, SHALL NOT execute an unpinned remote repository, and SHALL NOT use sudo.

#### Scenario: Install on a machine with Node 24
- **WHEN** the user runs the install command and `node` is version 24 or newer
- **THEN** `proton-drive-sync` from `~/.local/bin` runs this runtime, and the plugin directory still contains no symlink outside `.git`

#### Scenario: Node is missing or too old
- **WHEN** `node` is missing or older than 24
- **THEN** the command exits non-zero, names Node.js 24, and writes no runtime, link, or unit

### Requirement: An existing launcher or unit is left alone
If `~/.local/bin/proton-drive-sync` exists and does not point at this runtime, the installer SHALL stop without replacing it. If `~/.config/systemd/user/proton-drive-sync.service` already exists, the installer SHALL NOT modify it, including when `--service` is passed, and SHALL say that the existing unit was left in place.

#### Scenario: A hand-written unit is already there
- **WHEN** the user runs the install command with `--service` and a unit file is already present
- **THEN** that file's contents are unchanged

#### Scenario: Another binary owns the command name
- **WHEN** `~/.local/bin/proton-drive-sync` exists and points somewhere else
- **THEN** the installer exits non-zero and that path is unchanged

### Requirement: The optional user service starts this runtime without a tray
When `--service` is passed and the unit file is absent, the installer SHALL write `~/.config/systemd/user/proton-drive-sync.service` with an identifying marker for `io.github.zakkoo.proton-drive`, set `ExecStart` to this runtime's `proton-drive-sync run --no-tray`, enable it for the graphical session, and start it. The installer SHALL NOT edit Hyprland configuration. Running the installer again after success SHALL NOT write a second unit or replace the link with a different target.

#### Scenario: Opt in to the background service
- **WHEN** the user runs the install command with `--service` and no unit file exists
- **THEN** a user service is enabled and running, its start command includes `--no-tray`, and the unit file contains the plugin marker

#### Scenario: Second install
- **WHEN** the user runs the same install command again after it succeeded
- **THEN** the command exits 0 and the unit file and launcher path are unchanged

### Requirement: Engine removal does not delete user data
The user-facing removal command SHALL be:

`~/.config/omarchy/plugins/io.github.zakkoo.proton-drive/scripts/remove-engine`

It SHALL stop and delete `proton-drive-sync.service` only when that file contains this plugin's marker, SHALL delete the runtime directory, and SHALL delete `~/.local/bin/proton-drive-sync` only when it points at this runtime. It SHALL NOT delete the sync folder, `~/.config/proton-drive-sync`, the state database, the audit log, the recycle directory, or the keyring session. It SHALL NOT use sudo.

#### Scenario: Remove the engine after a marked install
- **WHEN** the user runs the removal command after this installer created the unit, the runtime, and the launcher link
- **THEN** those three are gone and the sync folder, config, state, audit log, recycle directory, and keyring session remain

#### Scenario: A foreign unit is installed
- **WHEN** the unit file exists and does not contain this plugin's marker
- **THEN** the removal command leaves the unit file in place
