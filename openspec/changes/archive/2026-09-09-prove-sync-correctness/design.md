## Context

See proposal.md. Facts from this revision:

- Local `./scripts/ci.sh` is green on Node 26.8.1 **and** Node 24.20.0 (the version `.github/workflows/ci.yml` pins). The GitHub API, logged in as `zakkoo`, returns **404** for `zakkoo/proton-drive-client-tool`; `gh` in this environment has no token (keyring). We cannot read the failing Actions log from here. Apply must open the real run once the repo is visible, and treat ubuntu `npm ci` / native `@parcel/watcher` as the remaining suspects.
- Existing tests are strong at the helper layer (reconcile table, executor journal, FakeRemote contract, conflict copies, baseline SIGKILL). They are weak at the **product** layer: CLI resolve/confirm/reject/release never run against a live engine; first-sync same-path conflict is reconcile-only; ignore/unsyncable/pair-change/empty listing/session-during-transfer/engine-start recovery are untested and in several cases likely wrong.
- Do not organise the suite around tray-pause or the detail page. Those stay one journey (`tray-status-ui`). The spine is README journeys + “absence is not a delete”.

## Goals / Non-Goals

**Goals:**
- One file per journey or helper; vitest projects `unit` / `e2e` / `fault`.
- EngineHarness + CLI `dispatch` (and a subprocess only where signals require it) prove every README journey.
- P0 data-loss paths are e2e assertions; if they fail, fix the product.
- CI on Node 24 locally and on GitHub.

**Non-Goals:**
- Moving tests out of `src/`.
- 100% line coverage of the Proton port or dbus-next.
- Live Proton in CI.
- Playwright / a real tray host.
- A spec-tag bureaucracy that delays the journeys. Optional `@spec` tags are fine; the e2e files **are** the map.

## Decisions

### D1. Layout

| Suffix | Project | Contents |
|---|---|---|
| `*.test.ts` | `unit` | Pure/isolated. Exclude `*.e2e.test.ts` and `*.fault.test.ts`. |
| `*.e2e.test.ts` | `e2e` | EngineHarness and CLI `dispatch` against FakeRemote. |
| `*.fault.test.ts` | `fault` | Existing crash-at-every-step suite. |

Split today’s `engine/e2e.test.ts` and `cli/cli.test.ts` by story, add files rather than growing one blob:

- `src/engine/firstSync.e2e.test.ts`
- `src/engine/dailyEdits.e2e.test.ts` (keep rename-storm, folder-move, feed, clock-skew, nested delete)
- `src/engine/safety.e2e.test.ts` (ignore, unsyncable, empty listing, replaced root, pair change, dry-run, brake)
- `src/engine/recovery.e2e.test.ts` (journal on `restart()`, session death, SIGINT via subprocess if needed)
- `src/cli/control.e2e.test.ts` (conflicts/held/quarantine/recycle/history through CLI + socket with **real** ids)
- `src/tray/detailPage.e2e.test.ts` and unit render tests stay, but they are not the headline.

Shared: `src/testing/` — FakeRemote, EngineHarness, `assertNoUserContentLost` used in e2e `afterEach`.

*Alternative:* `tests/` tree. Rejected — architecture is colocated.

### D2. When a test fails, believe the spec

Several “gaps” are unimplemented spec behaviour, not missing asserts:

- Ignore/unsyncable dropping a path looks like local delete (`trash_remote`).
- Pair change does not archive or reset baseline (`setup.ts` comment is wishful).
- `onRemoteChange` is never passed into the executor.
- Upload `auth` does not clear the session.
- Held-plan id is reused if the plan grows.

Write the e2e first. If it fails, fix the engine/config to match `openspec/specs/`. Do not weaken the test.

### D3. CLI e2e uses in-process `dispatch`, subprocess only for signals

`cli.test.ts` already runs `run` against FakeRemote. Extend that for resolve/confirm/reject/release/recycle-with-items/`--json` error shapes/`run --dry-run` **without** `--paused`. Spawn `node dist/cli/main.js` (or `tsx`) only for SIGINT/SIGTERM and stale-socket-after-kill.

### D4. FakeRemote extensions, not a second fake

Add only what journeys need: seed Proton documents, optional “listing returns root only”, delay hooks already present for in-flight status. Keep the RemoteDrive contract tests green.

### D5. Status surfaces are one journey

Shared `summarize` / human formatter so CLI, tray, and detail page cannot show empty defaults while the engine has counts. Detail-page `applySnapshot` + happy-dom so a blank DOM fails. Tray `dispatchMenuAction` so pause is not label-only. This implements `tray-status-ui`; it is not the organising principle of the suite.

### D6. CI

- `scripts/ci.sh`: typecheck, lint, unit, e2e, fault, build. Document `node -v` must be 24.x to match Actions.
- Workflow: keep Node 24, `npm ci`, `./scripts/ci.sh`. If ubuntu lacks a watcher prebuild, install build tools; do not skip tests.
- First apply task: make `zakkoo/proton-drive-client-tool` visible (create the repo or grant the GitHub App), read the real run log, fix that failure. Until then, Node 24 local green is necessary but not sufficient.

### D7. Traceability without a spreadsheet

Journey files named after the spec/README story. A small `specCoverage.test.ts` may fail on **new** untagged scenarios later; do not block this change on tagging all ~80 existing unit tests. The P0 e2e titles must name the scenario in plain language.

## Risks / Trade-offs

- [GitHub 404] → Apply creates or grants the repo and re-runs Actions; local Node 24 is already green so a GH failure is likely `npm ci` on ubuntu, not vitest logic.
- [P0 tests will fail on current code] → Expected. Fix product (D2). That is the point.
- [E2E timing] → EngineHarness short timers; `waitForConvergence`; isolate the 1000-file case in `dailyEdits.e2e.test.ts`.
- [Subprocess SIGINT flaky] → one test, long timeout; skip if the platform cannot signal, but Linux CI must run it.

## Migration Plan

No user data migration. Land tests + the product fixes they force + CI. Revert undoes it.

## Open Questions

None that change the approach. The exact GitHub log is unknown until the repo is visible; D6 says how to handle that without forking the plan.
