## 1. Package identity

- [x] 1.1 Add root `manifest.json` for `io.github.zakkoo.proton-drive` (`schemaVersion` number 1, name `Proton Drive Sync`, author `zakko`, MIT, version matching `package.json`, kinds `service` and `bar-widget`, entry points under `omarchy/`, `barWidget.defaultSection` `right`, `allowMultiple` false) and verify `omarchy plugin validate` fails only because the entry-point files are not written yet
- [x] 1.2 Add root MIT `LICENSE` copyright zakko 2026, leave `src/remote/proton/LICENSE-proton.md` in place, and verify both files are present and the Proton notice is unchanged
- [x] 1.3 Move `plugin-card-proton-drive-client-tool.png` to root `preview.png` and verify the old name is gone, the file is a regular PNG at most 50 MB and 40 megapixels, and no other root `preview.jpg`, `preview.jpeg`, `preview.webp`, or `preview.avif` exists

## 2. Engine probes the bar can call

- [x] 2.1 Add `proton-drive-sync doctor --json` reporting node ok, configured, logged-in, running, local root, remote root, and detail URL, and verify a unit test shows a boolean `loggedIn` with no session material in the output
- [x] 2.2 Start the loopback details page from `run` even with `--no-tray`, keep `--no-tray` from starting the StatusNotifierItem, and verify an existing headless run test still syncs and a new test can read the page URL only from the running engine
- [x] 2.3 Add `proton-drive-sync details --json` returning `{ "url" }` from the running engine, and verify it fails with a clear error when no engine is running and the URL is loopback-only

## 3. Runtime install and removal

- [x] 3.1 Add `scripts/install-engine` that refuses Node older than 24 without writing anything, builds from the lockfile into `$XDG_DATA_HOME/proton-drive-sync/runtime` (default `~/.local/share/proton-drive-sync/runtime`), refuses a destination inside the plugin directory or a symlinked runtime path, and writes the `~/.local/bin/proton-drive-sync` wrapper with the plugin marker and runtime marker. Verify with a fake `HOME` and stub `node`/`npm` that a too-old node writes nothing and a good run leaves the plugin directory without a new symlink
- [x] 3.2 Teach `scripts/install-engine --service` to write `~/.config/systemd/user/proton-drive-sync.service` only when that file is absent, with the plugin marker and `run --no-tray`, then enable it. Verify a pre-existing unit file is byte-for-byte unchanged, a second run does not move the wrapper, and a foreign `~/.local/bin/proton-drive-sync` is left in place with a non-zero exit
- [x] 3.3 Add `scripts/remove-engine` that deletes only a marked unit, a marked wrapper for this runtime, and the real runtime directory. Verify a fake-HOME test that config, state, audit, recycle, and a unit without the marker all remain

## 4. Bar and panel

- [x] 4.1 Add `omarchy/Model.js` mapping doctor and status payloads to the chip states in the omarchy-bar-status spec, and verify vitest covers not-installed, not-running, not-signed-in, not-configured, syncing, and attention
- [x] 4.2 Add `omarchy/Service.qml` that polls the marker-checked wrapper with argument arrays, never spawns `run`, and exposes status plus the control actions. Verify by reading the process invocations (no shell string, no `run` command) and that `qmllint -I "$OMARCHY_PATH/shell"` exits 0 on this file
- [x] 4.3 Add `omarchy/BarWidget.qml` and `omarchy/Panel.qml`: theme-colored Drive chip, left-click toggles, Escape closes, panel shows summary, transfers, held paths, conflicts, and quarantine, and sends pause, resume, sync-now, held confirm/reject, conflict resolve, and quarantine release through the service. Sign-in uses `omarchy-launch-tui proton-drive-sync login`. Setup runs only after confirm. Verify `qmllint` exits 0 on `BarWidget.qml` and opening logic does not call setup or login on load
- [x] 4.4 When `bar.shell.serviceFor` is null, show that the chip needs the built-in bar, and verify the widget does not start its own engine process in that branch

## 5. README

- [x] 5.1 Replace `README.md` with the Omarchy guide from the design (what it does, install, sign in, remove, what it needs, a shorter development tail) including the exact `omarchy plugin add` and `omarchy plugin remove` commands and the install, `--service`, and `remove-engine` commands. Verify a test fails the README if it contains `/home/zakko`, a Hyprland `exec-once`, or an instruction to run a package install inside the plugin directory, and that it states unofficial status, unsandboxed execution, the external dependencies, and what removal does not delete

## 6. Gates

- [x] 6.1 Run `omarchy plugin validate .` and verify exit 0, and verify `find` reports no symlink in the tree outside `.git`
- [x] 6.2 Run the project test and typecheck gate (`npm run check`) and verify it passes, including the new doctor, details, model, README, and installer tests
- [x] 6.3 Write `openspec/changes/publish-omarchy-plugin/submission.md` with the six marketplace headings in order, category `Productivity`, tags `bar`, `system`, `security`, unchecked checklist boxes, and maintainer notes about the explicit installer, no sudo, and the Proton card. Verify the file exists and that this change does not run `gh` or change repository visibility
