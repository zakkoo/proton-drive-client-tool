## Why

proton-drive-sync can trash Proton files and recycle local ones. The existing suite is large, but it mostly proves helpers: the reconciler table, the executor, FakeRemote. It does not prove the product as a user runs it, and it does not prove several paths that can delete the wrong tree. GitHub Actions is supposed to be the gate; locally `./scripts/ci.sh` is green on Node 26, while the workflow pins Node 24, and the GitHub repo is not visible to the logged-in API (404). We need an organised end-to-end suite that follows what the tool is specified to do, plus a CI gate that actually runs on the same Node GitHub uses.

## What Changes

- Treat the README + OpenSpec scenarios as the test list, not a handful of UI anecdotes. Split tests by layer (unit / e2e / fault) so the suite stays readable.
- Add engine-and-CLI end-to-end tests against FakeRemote for every user journey: login/setup/run, daily create-edit-rename-move-delete both ways, dry-run, first sync of two non-empty sides, conflicts/held/quarantine/recycle through the **CLI and socket** (today those commands are usage-only), session expiry while running, root gone / replaced, second instance, clean stop.
- Add tests for the data-loss holes that current coverage misses: ignore-after-sync looking like a local delete, unsyncable/unreadable looking like a delete, pair change reusing the old baseline, empty/incomplete remote listing, journal recovery on **engine start**, local-root identity change, auth during a transfer, held-plan id reused after the plan grows.
- When an end-to-end test fails because the product does not meet an existing spec, fix the product. The test is the contract.
- Make CI run the same steps locally and on GitHub on Node 24. Reproduce and fix whatever GitHub actually runs; if the GitHub repo is missing or the Actions app cannot see it, that is part of making the gate real.

No **BREAKING** CLI or config changes are intended. Status output may gain lines. Behaviour that already exists in the specs (ignore must not trash, pair change must first-sync) may start being enforced if it is currently wrong.

## Capabilities

### New Capabilities

- `test-suite`: Automated proof of the product: organisation, fakes, user-journey e2e, data-loss proofs, control-surface e2e, and the CI gate.

### Modified Capabilities

- `tray-status-ui`: CLI, tray, and detail page show the same live engine snapshot, and control actions from those surfaces reach the engine. This is one journey among many, not the whole change.

## Impact

- New and split `*.e2e.test.ts` files next to `engine/` and `cli/`, plus unit tests only where a helper has no proof at all (`views.ts`, `remoteMirror.ts`).
- Shared assertions in `src/testing/` (`assertNoUserContentLost`, FakeRemote hooks). No second test tree.
- Product fixes only where a new e2e fails against an existing spec (likely: ignore/unsyncable-as-delete, pair change, session-on-upload, held-plan id, `onRemoteChange` wiring).
- CI: `vitest` projects, `scripts/ci.sh`, `.github/workflows/ci.yml` on Node 24. GitHub repo access if Actions never ran.
