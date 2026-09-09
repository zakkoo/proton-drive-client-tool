# Proton Drive Sync

Two-way sync between one local folder and one folder in your Proton Drive, built to never lose your data:

- Nothing is ever deleted outright. Local deletes go to a recycle folder, remote deletes go to Proton's Trash.
- Every write is verified against its digest before it replaces anything.
- A "mass-change brake" stops and asks you before large deletions or replacements.
- Every action is written to an append-only audit log you can read.

Everything below is for Arch Linux with Hyprland. Commands are meant to be copied 1:1.

---

## 1. Requirements

| Need | How to check | If missing |
|---|---|---|
| Node.js 24 or newer | `node --version` | `mise use -g node@lts` or `sudo pacman -S nodejs npm` |
| A Secret Service (keyring) for the login session | `ls /usr/share/dbus-1/services/org.freedesktop.secrets.service` | `sudo pacman -S gnome-keyring libsecret` |
| A browser for login | any | |
| A bar with a system tray (for the tray icon, optional) | waybar with the `"tray"` module | The tool works without a tray; use the `status` command instead |

The keyring is started on demand over D-Bus the first time the tool stores your session. If it asks you to set a keyring password, do so; it protects your Proton session on disk.

---

## 2. Install

```bash
cd ~/Projects/proton-drive-client-tool
npm ci
npm run build
npm link
```

`npm link` puts a `proton-drive-sync` command on your PATH. Check it:

```bash
proton-drive-sync --help
```

To update later: `git pull && npm ci && npm run build`. The link keeps pointing at the new build.

---

## 3. Log in

```bash
proton-drive-sync login
```

Your browser opens Proton's sign-in page. Sign in there as usual, including 2FA. Keep the terminal open until it prints that login succeeded. Your password never passes through this tool; the resulting session is stored in the keyring.

If the browser does not open, copy the URL the command prints into a browser yourself.

Terminal only, no browser:

```bash
proton-drive-sync login --password
```

---

## 4. Choose the two folders

You need a folder in Proton Drive and an empty local folder.

**Start with a throwaway pair.** Create a folder called `sync-test` in the Proton Drive web app and put two or three unimportant files in it. Then:

```bash
mkdir -p ~/ProtonDriveTest
proton-drive-sync setup ~/ProtonDriveTest /sync-test
```

The remote path is always absolute and starts with `/`. The remote folder must already exist. `/` alone means your whole drive; do not use that until the throwaway pair has worked for you.

Setup records the identity of both folders. If either is later replaced by a different folder, the tool refuses to run instead of syncing the wrong thing.

---

## 5. First run: dry-run

A dry-run scans both sides and writes what it *would* do to the audit log without touching a single file.

```bash
proton-drive-sync run --dry-run
```

Leave it running for a minute, then stop it with `Ctrl+C`. Read the log:

```bash
ls ~/.local/state/proton-drive-sync/
tail -n 50 ~/.local/state/proton-drive-sync/audit.log
```

Each line is one JSON entry. Lines with `"kind":"would_do"` are the planned operations. For a fresh pair you should see only downloads (`download`, `create_local_folder`) and no `recycle_local` or `trash_remote`. If you see anything unexpected, stop here and ask.

**Important:** `--dry-run` is remembered. The tool stays in dry-run mode until you turn it off, so it can never slip into real changes by accident. To leave dry-run, edit the config:

```bash
nano ~/.config/proton-drive-sync/config.json
```

Change `"dryRun": true` to `"dryRun": false`, save, and start again.

---

## 6. Real sync of the throwaway pair

```bash
proton-drive-sync run
```

Now test the behaviours you care about while it runs. After each step wait about five seconds and check the other side:

1. Copy a file into `~/ProtonDriveTest`. It appears in Proton Drive.
2. Upload a file in the Proton Drive web app. It appears locally.
3. Rename a file locally. It is renamed remotely, not re-uploaded.
4. Move a file into a subfolder on either side.
5. Delete a file locally. In Proton Drive it moves to Trash. Locally deleted files that came from remote deletes land in `~/ProtonDriveTest/.proton-sync/recycle/`.
6. Edit the same file on both sides at once. Both copies are kept; the second gets a `.conflict-<machine>-<time>` name and shows up in `proton-drive-sync conflicts`.

Check the log again afterwards:

```bash
tail -n 100 ~/.local/state/proton-drive-sync/audit.log
```

When everything behaved, point the tool at your real folders (section 4 with your real paths), do a dry-run again (section 5), read the log, then run for real.

---

## 7. Daily use

Start the engine (foreground, with tray icon):

```bash
proton-drive-sync run
```

From another terminal while it runs:

| Command | What it does |
|---|---|
| `proton-drive-sync status` | State, current transfers, pending attention items |
| `proton-drive-sync pause` / `resume` | Stop and restart syncing without quitting |
| `proton-drive-sync sync-now` | Do not wait for the next change, sync immediately |
| `proton-drive-sync conflicts` | List conflicts |
| `proton-drive-sync conflicts resolve <id> keep_local` | Also `keep_remote` or `keep_both` |
| `proton-drive-sync quarantine` | Items whose verification failed; nothing is done with them until you release |
| `proton-drive-sync quarantine release <id>` | Re-check a quarantined item |
| `proton-drive-sync held` | Show a plan the brake stopped |
| `proton-drive-sync held confirm <id>` / `reject <id>` | Let it proceed, or drop it and keep everything |
| `proton-drive-sync history <path>` | Everything that ever happened to one file |
| `proton-drive-sync recycle` | List recycled files. `recycle purge` removes entries older than 30 days |

Add `--json` to any command for machine-readable output.

### Tray icon

With a running tray host the icon shows the state (syncing, idle, paused, offline, attention, waiting for confirmation, login needed). The menu has the status lines, pause/resume, sync now, held-plan review, conflicts, quarantine, and links to the sync folder, the recycle folder, the audit log and the config.

"Open details page" opens a local page in your browser with the transfer list, conflict inbox, quarantine and held plan. It is served only on 127.0.0.1 with a random token per run.

Without a tray host, `run` logs that no tray is available and keeps syncing. `--no-tray` skips the attempt.

### The brake

If one cycle would delete or replace more than 50 items, or more than 10 percent of your files, the tool stops that plan and waits. You will see a notification, the tray turns to "waiting for confirmation", and `proton-drive-sync held` shows exactly which files. Nothing happens until you confirm or reject. Thresholds live in `config.json` under `safety`.

---

## 8. Start automatically with Hyprland

Add to `~/.config/hypr/hyprland.conf` (on Omarchy: `~/.config/hypr/autostart.conf`):

```
exec-once = proton-drive-sync run
```

Or use a user service, which restarts it if it crashes:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/proton-drive-sync.service <<'EOF'
[Unit]
Description=Proton Drive Sync
After=graphical-session.target

[Service]
ExecStart=/home/zakko/.local/share/mise/installs/node/26.8.1/bin/proton-drive-sync run
Restart=on-failure
RestartSec=10

[Install]
WantedBy=graphical-session.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now proton-drive-sync.service
journalctl --user -u proton-drive-sync -f
```

Check `which proton-drive-sync` and use that path in `ExecStart` if it differs.

Only one instance can run per state directory; a second `run` refuses to start.

---

## 9. Where things live

| What | Path |
|---|---|
| Config | `~/.config/proton-drive-sync/config.json` |
| State database (sync baseline, journal) | `~/.local/share/proton-drive-sync/state.db` |
| Audit log | `~/.local/state/proton-drive-sync/audit.log` (rotated, kept 90 days) |
| SDK caches (safe to delete) | `~/.cache/proton-drive-sync/` |
| Recycled local files | `<sync folder>/.proton-sync/recycle/<timestamp>/` |
| Proton session | keyring, service name `proton-drive-sync` |

Set `PROTON_DRIVE_SYNC_DIR=/some/dir` to put all of the above under one directory, for example for a second, independent pair.

---

## 10. Troubleshooting

**`not logged in`** Run `proton-drive-sync login`.

**Login fails with a keyring or secret-tool error.** No Secret Service is running. Install `gnome-keyring`, log out and in again, and retry. If you accept storing the session as a file readable only by your user, set in `config.json`:

```json
"credentialsStore": "unsafe_file",
"acknowledgeUnsafeCredentialsStore": true
```

**`remote folder /x does not exist`** Create the folder in the Proton Drive web app first, and use its exact name.

**`Sync root is unavailable`** The local folder is missing or unmounted. The tool pauses instead of treating that as "everything was deleted". Fix the mount, then `proton-drive-sync resume`.

**State is `needs_login`** The session expired. Run `proton-drive-sync login` while `run` keeps going; it picks the new session up.

**I need a file back.** Local: look in `<sync folder>/.proton-sync/recycle/`. Remote: Proton Drive Trash. `proton-drive-sync history <path>` shows exactly what happened to it and when.

**Nothing seems to sync.** `proton-drive-sync status`. If it says `paused`, `proton-drive-sync resume`. If it says `awaiting_confirmation`, `proton-drive-sync held`.

**Logout / start over**

```bash
proton-drive-sync logout
rm -rf ~/.local/share/proton-drive-sync ~/.cache/proton-drive-sync
```

Your files are untouched by this; only the tool's own state is removed. The next `run` does a first sync, which never deletes anything.

---

## Development

The test suite is split into three vitest projects: `unit` (pure/isolated
`*.test.ts`), `e2e` (`*.e2e.test.ts` — full engine and CLI against the fake
remote and a real temp tree), and `fault` (`*.fault.test.ts` — crash injection).

```bash
npm run check                    # typecheck + lint + unit tests
npm run test -- --project e2e    # end-to-end journeys
npm run test:fault               # crash-injection suite
./scripts/ci.sh                  # everything, including the build
```

**Use Node 24.x** for `./scripts/ci.sh`. GitHub Actions pins Node 24 (see
`.github/workflows/ci.yml`); running the gate on the same major keeps local
green and CI green in step (`mise use node@24` or `nvm use 24`).

See `src/ARCHITECTURE.md` for the design, and `openspec/changes/proton-drive-sync/` for the proposal, specs and task list.
