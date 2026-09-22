## Context

See proposal.md for why this is a marketplace package. The constraints that decide the shape:

- `omarchy plugin add` clones the git repo into `~/.config/omarchy/plugins/<id>/`, validates the manifest, and enables it over IPC. It never runs install hooks, never uses sudo, and the local validator rejects any symlink outside `.git`.
- This repo's production build is an esbuild bundle that still `require`s the native module `@parcel/watcher`. A checkout with `node_modules` cannot be a valid plugin directory.
- The engine already refuses a second instance, speaks `status --json` and the control commands over its socket, and only serves the loopback details page from `startTray`. `--no-tray` skips that whole path today.
- On the built-in Omarchy bar, a third-party plugin with a `service` kind gets its own service object through `bar.shell.serviceFor(id)` while the widget is enabled. A replacement bar does not hand out that object.
- `https://github.com/zakkoo/proton-drive-client-tool` is not anonymously visible. The catalog has no `io.github.zakkoo.proton-drive`. Other Proton Drive listings exist under other ids; this id stays ours.
- The supplied card is a 1200×630 PNG (about 0.76 megapixels, 495 KB), under the marketplace limits of 50 MB and 40 megapixels.

## Goals / Non-Goals

**Goals:**

- One root manifest the installed `omarchy plugin validate` accepts, plus QML that lints against `$OMARCHY_PATH/shell`.
- A bar chip and panel over the engine that is already running.
- An explicit installer and remover whose user-facing paths are the ones in the engine-runtime-install spec.
- A README in the voice of the Omarchy manual: short, second person, no personal paths.
- A submission draft the owner can approve later.

**Non-Goals:**

- Publishing to npm, or flipping `package.json` `"private"`.
- Making the repository public, pushing, or opening the marketplace issue.
- A file browser, drag-and-drop uploads, or a Nautilus mount.
- Editing Hyprland, rewriting an existing systemd unit, or desktop notifications from the bar (the chip is the attention surface; the tray notifier stays as it is when the tray is on).
- Support for a replacement bar's missing service object beyond a chip that explains it needs the built-in bar.

## Decisions

### The repo is the plugin

Manifest, license, preview, and QML live in this repository. The shell entry points live under `omarchy/` so the Node tree stays put:

- `omarchy/Service.qml` → `entryPoints.service`
- `omarchy/BarWidget.qml` → `entryPoints.barWidget`
- `omarchy/Panel.qml` loaded by the bar widget, not declared as its own kind
- `omarchy/Model.js` for pure presentation, tested from vitest

`manifest.json` uses schema version number `1`, id `io.github.zakkoo.proton-drive`, name `Proton Drive Sync`, author `zakko`, license `MIT`, homepage `https://github.com/zakkoo/proton-drive-client-tool`, version copied from `package.json` (`0.1.0`). `barWidget` sets `displayName` to `Proton Drive`, `category` to `Files`, `defaultSection` to `right`, `allowMultiple` to `false`. The description is one sentence: two-way sync between a folder on this machine and a folder in Proton Drive.

Alternative considered: a second, QML-only repository. Rejected because the marketplace wants the plugin at the repository root the user already has, and a split would make `plugin add` install a shell with no matching engine source.

### The shell never starts the engine

`Service.qml` polls. It does not spawn `run`. Enabling the plugin only loads the service because the widget is on the bar, which is enough for the shell to treat the plugin as enabled and start a `service` entry point.

The service resolves `~/.local/bin/proton-drive-sync` and, when that launcher carries this plugin's marker, runs it as an argument array (`doctor --json`, `status --json`, and the existing control commands). No shell string. Poll about every two seconds while the panel is open or the engine is mid-sync, otherwise about every five seconds. A missing binary is "not installed". A binary that fails `status` is "not running". `doctor --json` answers configured / signed-in without starting a sync and without printing session material.

The bar widget reads `bar.shell.serviceFor("io.github.zakkoo.proton-drive")`. Chip text is a short theme-colored label ("Drive"), using `barForeground` and the bar's urgent color for attention. The wide preview PNG is not the bar icon.

Sign-in runs `omarchy-launch-tui proton-drive-sync login`, which execs the command without a shell. Setup runs `proton-drive-sync setup <local> <remote>` as an argument array only after the user confirms. The panel does not ask for the Proton password.

Pause, resume, sync-now, held confirm/reject, conflict resolve, and quarantine release call the existing CLI subcommands. The panel lists held-plan paths from `status`. Conflict and quarantine rows come from `conflicts --json` and `quarantine --json`.

Alternative considered: a systemd unit whose `ExecStart` points into the plugin directory, as some Drive plugins do. Rejected because `plugin remove` would delete the binary out from under the unit, and because `npm ci` in that directory creates symlinks the validator rejects.

### The details page starts with the engine, not with the tray

The panel has to open the loopback details page, and the Omarchy unit runs `--no-tray`, which today never binds that page. Split the page server out of `startTray`: `run` always listens on `127.0.0.1` with the existing random token, and `--no-tray` only skips the StatusNotifierItem. Add `proton-drive-sync details --json`, answered by the running engine, returning `{ "url" }` and nothing else. The panel opens that URL. `doctor` reports `detailUrl: null` when nothing is running.

This does not change tray behavior when the tray is on. It does mean a headless `run` binds a localhost port it did not bind before. The page stays token-gated and loopback-only.

### Runtime install is a copy, then `npm ci`, outside the checkout

`scripts/install-engine` (no extension, matching the documented path):

1. Refuse unless `node` is 24 or newer, and write nothing on that failure.
2. Runtime directory: `$XDG_DATA_HOME/proton-drive-sync/runtime`, default `~/.local/share/proton-drive-sync/runtime`. Refuse if that path is inside the plugin directory, or if it is a symlink.
3. If `~/.local/bin/proton-drive-sync` exists and lacks this plugin's marker, exit non-zero and leave it.
4. If `~/.config/systemd/user/proton-drive-sync.service` exists and lacks the marker, leave the file untouched. With `--service`, still do not rewrite it. If it has the marker, refresh the runtime and run `systemctl --user enable --now` without changing the file.
5. Copy `package.json`, `package-lock.json`, `scripts/`, `src/`, and `tsconfig.json` into a staging directory beside the runtime, then `npm ci` and `npm run build` there, then `npm prune --omit=dev`. Swap the staging directory into place. Dependencies come only from the lockfile.
6. Write `~/.local/bin/proton-drive-sync` as a wrapper, not a symlink. Node would resolve `@parcel/watcher` from the symlink's directory and miss `node_modules`. The wrapper is:

   - shebang `#!/usr/bin/env bash`
   - marker `# installed-by=io.github.zakkoo.proton-drive`
   - marker `# runtime=<absolute runtime path>`
   - `exec node <runtime>/dist/cli/main.js "$@"`

   A second run may rebuild the runtime. It does not move the wrapper.

`--service`, only when the unit file is absent, writes a user unit containing `# installed-by=io.github.zakkoo.proton-drive`, `ExecStart=<absolute wrapper> run --no-tray`, `After=graphical-session.target`, `Restart=on-failure`, and `WantedBy=graphical-session.target`. Then `systemctl --user daemon-reload` and `enable --now`. No Hyprland edits. No sudo.

`scripts/remove-engine` stops and deletes the unit only when the marker is present, deletes the wrapper only when both markers match this runtime, and deletes the runtime directory only when it is a real directory containing the marker file the installer wrote. It does not touch `~/.config/proton-drive-sync`, `$XDG_STATE_HOME` / `~/.local/state/proton-drive-sync`, `$XDG_CACHE_HOME` / `~/.cache/proton-drive-sync`, the sync folder, the recycle directory, or the keyring.

An existing hand-written unit, including one that points at a mise binary, keeps working. The bar attaches to whatever engine is already answering the socket. The installer will not "fix" that unit.

### README

Replace `README.md`. Shape, in order: a few sentences on what the two folders do and the three safety rules; Install (plugin add, then the engine command, then the optional `--service` command); Sign in and choosing folders from the bar; Remove (plugin remove, then `remove-engine`, and what both leave behind); a short "What it needs" close (Node 24, the keyring Omarchy already runs, the Proton packages, unsandboxed, unofficial, MIT, and the Proton copyright on the adapted code). Development stays as a shorter tail pointing at `src/ARCHITECTURE.md` and the existing npm scripts. No `/home/zakko`, no Hyprland `exec-once`, no `npm ci` inside the plugin directory.

Voice: the Omarchy manual. Short sentences, second person, no numbered lab, no emoji.

### Preview, license, submission

Move `plugin-card-proton-drive-client-tool.png` to root `preview.png`. Do not add a second preview file.

Add root `LICENSE`, MIT, copyright zakko, 2026. Leave `src/remote/proton/LICENSE-proton.md` as it is.

Write the submission body to `openspec/changes/publish-omarchy-plugin/submission.md` with the six headings from the marketplace guide, in that order. Category `Productivity`. Tags `bar`, `system`, `security`. Checklist boxes unchecked. Maintainer notes: service plus bar widget; the engine is built only by `scripts/install-engine`; no sudo; no download piped into a shell; removal does not delete user files; the preview is the supplied Proton Drive card and the owner must confirm they can submit it. Do not run `gh`, do not change visibility.

### Checks

Vitest covers `Model.js`, `doctor --json` (no secret in the output, false when the session is absent), the details command when an engine is up, and the installer/remover against a fake `HOME` with stub `node`, `npm`, and `systemctl`. A source test asserts the manifest fields, the README commands, and the absence of `/home/zakko`.

On this machine, `omarchy plugin validate .` and `qmllint -I "$OMARCHY_PATH/shell"` on the two entry points must exit 0. GitHub Actions does not have the Omarchy shell, so those two stay a local gate rather than a new CI dependency.

## Risks / Trade-offs

- [The preview uses the Proton Drive mark and slogan] → The draft says so, and the issue is not opened until the owner confirms they may submit that image. The README states the plugin is unofficial.
- [Headless `run` binds a new localhost port] → Same token-gated page the tray already served. Document it next to the details command. Tests that assumed `--no-tray` starts no server need to expect the page instead.
- [`npm ci` during install needs a network and a lot of disk under the runtime directory] → It is explicit, lockfile-pinned, and outside the plugin tree. The wrapper keeps native-module resolution working after `npm prune --omit=dev`.
- [A shell reload can drop the service object and respawn it] → The service only polls, so a reload does not kill the sync. The systemd unit is what survives logout of the shell.
- [Replacement bars cannot see the service] → The chip says it needs the built-in bar. Document one sentence in the README.
- [The GitHub URL 404s anonymously, so validation on a future issue would fail] → Called out in the draft. Visibility is the owner's step, not this change's.
- [Another `proton-drive-sync` on `PATH` ahead of `~/.local/bin`] → The service uses the marker-checked wrapper path, not a `PATH` search.

## Migration Plan

1. Land the package files. Existing checkouts keep syncing; nothing rewrites their unit or config.
2. An Omarchy user adds the plugin, runs `install-engine`, and optionally `--service`. If they already have a unit, they leave it and the bar follows that process.
3. Rollback of the shell package is `omarchy plugin remove io.github.zakkoo.proton-drive`. Rollback of the runtime is `scripts/remove-engine` while the plugin checkout still exists. Neither deletes synced files. Restoring the old README is a git revert.

## Open Questions

None that change the specs or the task breakdown. Whether the owner may submit the Proton card, and whether the repository becomes public, are confirmation gates in the submission draft, not design choices.
