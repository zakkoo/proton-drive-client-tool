## 1. Card shell

- [x] 1.1 Restyle the document in `src/tray/detailPage.ts` with the mint `#cdfae4`, lavender `#d0d8fc`, card `#fcfdfe`, ink `#2c3343`, cyan `#2cd1ec`, and folder-blue `#42aefc` variables, 20px card radius, and pill buttons. Keep the loopback routes and the action switch. Order the sections as header, `#action-error`, `#held`, `#conflicts`, `#quarantine`, `#transfers`, `#lines`, `#proton-documents`, `#recycle`, and add `#glance`. Verify `src/tray/detailPage.e2e.test.ts`: the served page contains those six colors, `border-radius`, `function applySnapshot`, and the existing ids; it has no external stylesheet or script URL; an unknown token is still 404.

## 2. Readable status

- [x] 2.1 In `applySnapshot`, put each `summaryLines` entry in its own block inside `#lines`, leave `#state` as the spaced state word, fill `#glance` with the same `Sync (done/total)` or `Paused (done/total)` string as `glanceText`, and show a dry-run note only when `dryRun` is true and a degraded note only when `degraded` is true. Verify `src/tray/detailView.test.ts`: the last-sync and files sentences are in separate blocks and still present, the glance text equals `glanceText` for a syncing 34/5685 snapshot and a paused one, and the dry-run note is absent unless the flag is set.

## 3. Paged lists

- [x] 3.1 Page Proton documents, conflicts, quarantine, recycle, transfers, and held-plan paths at 25 rows inside `applySnapshot`, with the unfiltered count in the heading, a case-insensitive path filter, and previous/next controls. Store the page and query on `doc.__detailUi`. A new query returns to page 1. A later `applySnapshot` keeps the page and query, and clamps the page when the list shrinks. Replacing rows leaves a focused filter input in place. An empty section is one line containing `none`. Verify `src/tray/detailView.test.ts`: 30 document paths show 25 and the count 30; activating next shows the other 5; filtering `agenda` hides the rest and the heading still says 30; clearing the filter shows the first page of all 30; a second `applySnapshot` on page 2 with a filter stays there; quarantine with no rows contains `none`.

- [x] 3.2 Show a conflict as a short summary plus a disclosure with the pretty-printed local and remote JSON, and keep Keep local, Keep remote, and Keep both on that row. Show each recycle time as a `<time>` whose text includes a local rendering and the ISO instant. Verify `src/tray/detailView.test.ts` for a conflict with `size` fields: the summary and the JSON are both in the row, the three choices are present, and a recycle row contains the ISO instant inside `<time>`.

## 4. Failed actions

- [x] 4.1 When `act` gets `{ ok: false, error }`, store that error on `__detailUi` and let the refresh render it in `#action-error`. A later successful action clears it. Verify a happy-dom test that evaluates `clientScript()` against a stubbed `fetch`: a failing pause shows the returned message, and a following successful pause removes it.

## 5. Check

- [x] 5.1 Run `npx vitest run --project unit src/tray/detailView.test.ts` and `npx vitest run --project e2e src/tray/detailPage.e2e.test.ts`, then `npx tsc -p tsconfig.json --noEmit`. Confirm all three pass, and confirm `git diff --stat` has no changes under `src/engine`, `src/cli`, `src/execute`, `omarchy`, or `README.md`.
