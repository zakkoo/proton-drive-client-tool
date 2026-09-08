## 1. CI and layout

- [ ] 1.1 Split vitest projects: `unit` = `*.test.ts` excluding `*.e2e.test.ts`/`*.fault.test.ts`, `e2e` = `*.e2e.test.ts`, `fault` unchanged; verify `npx vitest run --project unit` no longer runs `engine/e2e.test.ts`
- [ ] 1.2 Point `scripts/ci.sh` at unit then e2e then fault, and document Node 24 in README; verify `./scripts/ci.sh` under Node 24.20.x still typechecks, lints, tests, and builds
- [ ] 1.3 Make GitHub see this repo (create `zakkoo/proton-drive-client-tool` or grant the GitHub App), push, and read the Actions log; verify we have the actual failing step (or a green run) rather than a 404
- [ ] 1.4 Fix whatever ubuntu `npm ci` / Actions actually fails (native watcher, postinstall types, permissions); verify the workflow on Node 24 matches `scripts/ci.sh`

## 2. Shared e2e helpers

- [ ] 2.1 Add `assertNoUserContentLost` in `src/testing/` and call it from engine e2e `afterEach` and the fault suite; verify a dropped file fails the helper
- [ ] 2.2 Extend FakeRemote only as needed (Proton-document seed, listing that returns root only); verify `src/remote/contract.test.ts` still passes
- [ ] 2.3 Split `src/engine/e2e.test.ts` into `dailyEdits.e2e.test.ts` keeping the existing scenarios; verify they still pass under `--project e2e`

## 3. Data-loss proofs (product must match existing specs)

- [ ] 3.1 Engine e2e: after sync, add the file to `ignore` and cycle; verify the remote node is not trashed and the local file remains `@spec test-suite/Ignore after sync` — if this fails, fix ignore so a previously synced path is not planned as a local delete
- [ ] 3.2 Engine e2e: after sync, chmod 000 the file and, separately, replace it with a symlink; verify no remote trash `@spec test-suite/Unreadable or symlink after sync` — if this fails, treat unsyncable as blocked, not deleted
- [ ] 3.3 Engine e2e: populated baseline, then a failed listing and a listing that returns only the root; verify zero trash and zero recycle `@spec test-suite/Incomplete or empty remote listing`
- [ ] 3.4 Engine e2e: replace the local root directory (new inode, same path); verify error/pause and no deletes `@spec test-suite/Local root replaced`
- [ ] 3.5 Engine e2e: `setup` to a different remote folder then `run`; verify first-sync (no deletes) and the old baseline is not applied `@spec test-suite/Pair changed` — if this fails, implement the archive/reset `setup.ts` already describes
- [ ] 3.6 Keep `forbidden.test.ts` and the unlink allow-list tagged `@spec test-suite/Source scan`; verify they still fail if `deleteNodes` or a new user-data unlink appears

## 4. README journeys

- [ ] 4.1 `src/engine/firstSync.e2e.test.ts`: no baseline, both sides non-empty, including same path different content; verify copies + conflicts and zero trash/recycle `@spec test-suite/First sync of two non-empty sides`
- [ ] 4.2 CLI e2e: login, setup, `run --dry-run --no-tray` **without** `--paused` on a non-empty pair; verify no mutations, would-do in the audit log, config `dryRun` still false unless set in the file `@spec test-suite/First pair`
- [ ] 4.3 `dailyEdits.e2e.test.ts` already covers live both-way edits; add a live same-file edit on both sides while running; verify a conflict, not an overwrite `@spec test-suite/Daily edits both ways`
- [ ] 4.4 `src/cli/control.e2e.test.ts`: create a real conflict, held plan, and quarantine; run `conflicts resolve`, `held confirm`, `held reject`, `quarantine release` via CLI **and** socket with real ids; verify engine state matches README `@spec test-suite/Conflict, brake, and quarantine through the CLI`
- [ ] 4.5 Recycle a file through the engine, `recycle` lists it, age a bucket, `recycle purge` removes only aged and logs paths `@spec test-suite/Recycle list and purge`
- [ ] 4.6 `--json` contracts: not-running `{running:false}` exit 3, engine error `{ok:false,error}` exit 1, `held`/`conflicts`/`quarantine` non-empty JSON; verify scripts can parse stdout

## 5. Recovery and session

- [ ] 5.1 Leave an in-progress journal row, `EngineHarness.restart()`; verify recovery runs before a new plan and no content is lost `@spec test-suite/Stop and restart`
- [ ] 5.2 Inject auth on listing and on upload; verify `needs_login`, no trash, and a subsequent login in-process resumes `@spec test-suite/Session dies while running` — if upload-auth does not clear the session, fix that wiring
- [ ] 5.3 Subprocess: built CLI `run --no-tray`, SIGINT, then SIGTERM on a second run; verify exit 0, socket gone, `status` not-running
- [ ] 5.4 Stale control socket after a dead process: next `run` starts; verify listen succeeds and status works
- [ ] 5.5 Fault project still survives every executor step with `assertNoUserContentLost`

## 6. Engine internals that journeys depend on

- [ ] 6.1 Unit tests for `listRemoteTree` / `RemoteMirror`: throw leaves incomplete, does not keep a half listing; verify a failed refresh cannot look complete
- [ ] 6.2 If executor `onRemoteChange` is unwired, wire it or prove `stale_view` prevents recycle after our own upload with the feed disabled
- [ ] 6.3 Held-plan id: grow the plan after hold, then confirm the original id; verify the engine does not silently apply extra deletes
- [ ] 6.4 Watcher: unreadable nested directory while running does not mark the snapshot complete and delete children; verify no remote trash
- [ ] 6.5 Seed a Proton document plus a normal file; verify the file syncs, the document is blocked, nothing trashed

## 7. Status surfaces (one journey, not the whole suite)

- [ ] 7.1 Human CLI status and `summarize()` include last sync and file counts after a real convergence; verify they are not empty when files exist
- [ ] 7.2 Extract `applySnapshot` for the detail page, happy-dom unit test on a fixture, e2e after sync; verify the visible page shows state and counts
- [ ] 7.3 `dispatchMenuAction` + idle tray “Pause syncing” on EngineHarness; verify paused and no upload until resume
- [ ] 7.4 Sample status during a slowed transfer; verify transfers and pending are non-zero on engine status and the formatter

## 8. Gate

- [ ] 8.1 `npx vitest run --project unit`, `--project e2e`, `--project fault` each pass
- [ ] 8.2 `npm run typecheck` and `npm run lint` pass
- [ ] 8.3 `./scripts/ci.sh` on Node 24 passes; a deliberately failing test fails the script
- [ ] 8.4 GitHub Actions on this repository is green on the default branch (or the remaining failure is pasted from the log and fixed)
