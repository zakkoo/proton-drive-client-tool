# Proton Drive Sync

Proton Drive Sync keeps one folder on this machine and one folder in Proton Drive the same. Create, edit, rename, or move a file on either side and the other side follows. A delete is not thrown away: here it goes to a recycle folder, and in Proton Drive it goes to Trash. A large delete or replace waits for you. If both sides change the same file, you keep both copies.

Sign-in and Drive access are based on Proton's official [Drive SDK](https://github.com/ProtonDriveApps/sdk). The account code in this repo is a Node port of that repository. The two-way sync around it is this project.

Proton does not ship a sync client for Linux yet. This plugin is an unofficial stand-in for Omarchy until Proton releases its own. It is not affiliated with Proton AG or the Omarchy project.

## Install

```sh
omarchy plugin add https://github.com/zakkoo/proton-drive-sync.git --enable
```

The chip lands on the right of the built-in bar. It needs that bar. A replacement bar cannot see this plugin's service.

Then install the engine once. This builds it outside the plugin folder and puts `proton-drive-sync` on your PATH:

```sh
~/.config/omarchy/plugins/io.github.zakkoo.proton-drive/scripts/install-engine
```

To start it with your graphical session:

```sh
~/.config/omarchy/plugins/io.github.zakkoo.proton-drive/scripts/install-engine --service
```

## Sign in

Click the chip. Choose Sign in. A terminal opens Proton's own page, and the password stays there. Then name the local folder and the remote folder, for example `/my-files`, and confirm. Nothing is written until you do.

## Day to day

The chip tells you what the engine is doing. Open it to pause, resume, sync now, confirm or reject a held change, keep one side of a conflict, or release a file the engine refused to touch. Open folder and Open details show up while the engine is running.

`proton-drive-sync doctor` reports whether you are installed, signed in, and running. `proton-drive-sync details` prints the loopback details page for that running engine.

## Remove

Stop the engine while the plugin folder is still on disk:

```sh
~/.config/omarchy/plugins/io.github.zakkoo.proton-drive/scripts/remove-engine
```

Then remove the shell plugin:

```sh
omarchy plugin remove io.github.zakkoo.proton-drive
```

`omarchy plugin remove` takes the chip off the bar. It does not delete your sync folder, your Proton session, or the tool's config. `remove-engine` takes the runtime, the launcher, and this plugin's user service. Your files stay either way.

## What it needs

- Omarchy with the built-in bar. The plugin runs unsandboxed, with your user privileges, inside the shell
- Node.js 24 or newer
- A Secret Service for the Proton session, which Omarchy already runs
- `@protontech/drive-sdk`, `@protontech/crypto`, and `@parcel/watcher`, fetched by the engine installer from this repo's lockfile
- A Proton account

The project is MIT. See `LICENSE`. The adapted Proton code keeps Proton's own MIT notice in `src/remote/proton/LICENSE-proton.md`.

## Development

The engine and the reasons for it are in `src/ARCHITECTURE.md`.

```sh
npm run check
npm run test -- --project e2e
npm run test:fault
```

`./scripts/ci.sh` is the full gate. Run it on Node 24.
