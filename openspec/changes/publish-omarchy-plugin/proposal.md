## Why

Proton Drive still has no first-party sync client on Omarchy, and this tool is only installable today as a personal Node checkout with a machine-specific README. The [Omarchy plugin marketplace](https://plugins.omarchy.org/) is how an Omarchy user finds and installs shell integrations, and its listing rules require a public git repo with a root `manifest.json`, a license, install and removal instructions, and an optional root preview. The repo is not that package yet: there is no manifest, no license file, the README is a walkthrough for one Hyprland setup, and the prepared card is an untracked PNG in the repo root under a name the marketplace will not pick up.

## What Changes

- Publish this repository as one Omarchy Quattro plugin, `io.github.zakkoo.proton-drive`, with a root manifest, a `service` plus a `bar-widget`, and the supplied card moved to root `preview.png`.
- Replace the README with a short guide for any Omarchy user: what the plugin does, how to add it, how to sign in and choose the two folders, and how to remove it. Document the license, external dependencies, and the fact that the plugin is unofficial.
- Add an explicit engine installer. `omarchy plugin add` only copies files into `~/.config/omarchy/plugins/<id>/` and never runs hooks. The Node engine, its native watcher, and an optional systemd user unit are installed only when the user runs that installer, and they land outside the plugin checkout so the checkout stays free of symlinks.
- Add a root MIT license. Keep the existing Proton copyright notice on the adapted Proton code.
- Validate with `omarchy plugin validate` and `qmllint` before any marketplace submission.
- Draft the marketplace issue for category `Productivity` and tags `bar`, `system`, `security`. Do not make the GitHub repo public and do not open the issue until the owner confirms the submission checklist, including the right to submit the preview.

The sync engine's safety rules, CLI, and on-disk layout stay as they are. Nothing in this change deletes a sync folder, a Proton session, or the tool's config as part of install or removal.

## Capabilities

### New Capabilities

- `omarchy-plugin`: Marketplace package contract: manifest, preview, license, Omarchy-facing README, and the checks that must pass before submission.
- `omarchy-bar-status`: Bar widget and in-shell service that show the running engine and send the existing control commands.
- `engine-runtime-install`: Explicit install and removal of the Node runtime and the optional user service, outside the plugin checkout, without touching user files.

### Modified Capabilities

None. Tray, sync, and configuration requirements are unchanged. The bar is an additional surface over the existing control socket, and the engine started for Omarchy uses the existing `--no-tray` flag.

## Impact

- New root files: `manifest.json`, `LICENSE`, `preview.png` (moved from `plugin-card-proton-drive-client-tool.png`), QML entry points, and a small install/remove script. `README.md` is rewritten for Omarchy users.
- New runtime location: `$XDG_DATA_HOME/proton-drive-sync/runtime` (default `~/.local/share/proton-drive-sync/runtime`) and a `~/.local/bin/proton-drive-sync` link. Optional unit: `~/.config/systemd/user/proton-drive-sync.service`, written only by the explicit installer and only when that file is absent.
- Dependencies to document, not add: Node.js 24 or newer, a Secret Service (already part of Omarchy), `@protontech/drive-sdk`, `@protontech/crypto`, `@parcel/watcher`. No sudo, no downloaded shell scripts, no edits to Hyprland config.
- Distribution: public `https://github.com/zakkoo/proton-drive-client-tool` (today that URL is not anonymously visible) and a submission issue on `omacom/omarchy-plugin-marketplace`. The id is unused in the current catalog. Opening the issue and changing repository visibility wait for an explicit owner confirmation.
- The plugin id is permanent. Changing it later is a different listing.
