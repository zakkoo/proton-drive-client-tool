## Context

See proposal.md for why this change exists. The behaviour contract is `specs/tray-status-ui/spec.md`.

The page is one HTML document in `src/tray/detailPage.ts`. `applySnapshot` in `src/tray/detailView.ts` is a pure function of `(document, data)` with no imports, and `clientScript()` inlines `applySnapshot.toString()` plus a two-second `fetch` of `/api/state`. That is what lets the unit test call the same function the browser runs. The loopback routes and the action switch already match the tray: pause, resume, sync, confirm, reject, resolve, release.

`glanceText` in `src/engine/status.ts` is the bar's `Sync (done/total)` / `Paused (done/total)` line. Transfer concurrency is at most 16, so a page of 25 rows holds every in-flight transfer. Proton document paths, recycle entries, and a held plan's affected paths are not bounded that way.

The colors below are averages sampled from the root preview card `preview.jpg`.

## Goals / Non-Goals

**Goals:**

- Keep `applySnapshot` self-contained so `toString()` still is the browser renderer, and keep the existing element ids (`state`, `reason`, `lines`, `proton-documents`, `held`, `transfers`, `conflicts`, `quarantine`, `recycle`) so the current assertions have a place to read.
- Page and filter on the client, from the snapshot the server already returns.
- Leave a focused filter field in place across the two-second refresh.

**Non-Goals:**

- A dark theme, a copy-path button, server-side paging, or a new route.
- A browser bundler, a CSS framework, or a stylesheet loaded from another host.
- Any edit under `src/engine`, `src/cli`, `src/execute`, `omarchy`, or the README.

## Decisions

### Style the document the server already sends

Put the CSS in the `<style>` of the page in `detailPage.ts`, as custom properties:

- `--pds-mint: #cdfae4` and `--pds-lavender: #d0d8fc` on a left-to-right page gradient
- `--pds-card: #fcfdfe` for panels
- `--pds-ink: #2c3343` for text
- `--pds-cyan: #2cd1ec` for the accent
- `--pds-blue: #42aefc` for progress and the active control

Panels use `border-radius: 20px`. Buttons and the state pill use a full pill radius. The column is centered, max-width 960px. Tables scroll inside the card. The three actions stay in the header. The one that matches the state (Pause while running, Resume while paused, Sync now otherwise) gets the cyan fill. The other two stay outline buttons. They still call `act('pause')`, `act('resume')`, and `act('sync')`.

The served markup keeps the ids above and adds `#glance` and `#action-error`. Section order in the document: header, action error, held plan, conflicts, quarantine, transfers, reading lines, Proton documents, recycle.

**Alternative:** a separate `.css` file fetched by the browser. That is a second route and a second thing to token-check. Rejected.

**Alternative:** restyle `omarchy/Panel.qml` to match. The request is the details page. Rejected.

### Page in the renderer, store the user's place on the document

`applySnapshot` owns a page size of 25. For each section it filters by a case-insensitive substring of the path (the held-plan paths, the conflict path, the quarantine path, the recycle path, the transfer path, the document path), then slices 25 rows. The heading text includes the unfiltered count. The pager shows the visible range and the filtered count, and disables Previous on the first page and Next on the last. A filter with no matches writes `none` in the row area and leaves the unfiltered count in the heading.

The page index and query live on the document object (`doc.__detailUi`), not in module scope, so the stringified function and the unit test share it. Defaults are page 1 and an empty query. Changing the query sets that section back to page 1. A refresh that shrinks the list clamps the page instead of leaving it blank.

Each section's DOM is a toolbar plus a row container. Refresh replaces the rows and the pager label. If the filter input already exists and is the active element, it is not recreated. Otherwise its value is set from the stored query.

**Alternative:** ask `/api/state` for one page. That changes the snapshot the rest of the page, and any other client of that JSON, would see. Rejected.

**Alternative:** helper functions outside `applySnapshot`. `toString()` would not include them, and the browser would throw. Helpers stay nested inside `applySnapshot`.

### Repeat the glance format inside the renderer

The stringified function cannot call `glanceText`. Inside `applySnapshot`, when `progress` is non-null and `total > 0`, set `#glance` to `Sync (done/total)` while state is `syncing` and `Paused (done/total)` while state is `paused`. Otherwise leave it empty. The unit test compares that text with `glanceText` so the two copies cannot drift unnoticed.

Reading lines are one child element per `summaryLines` entry inside `#lines`. `#lines` text still contains each sentence. `#state` text stays the state with underscores turned into spaces.

Conflict cells show size, mtime, and a short sha1 when those fields exist, plus a `<details>` whose body is the pretty-printed JSON of that side. The three resolve buttons stay on the row. Recycle time is a `<time datetime="...">` whose text includes a `toLocaleString()` value and the ISO instant.

`act` in `clientScript()` writes a failed response's `error` string onto `__detailUi` and then refreshes, so `applySnapshot` paints `#action-error` and the next successful action clears it. The POST paths and bodies do not change.

Dry run and degraded are short notes in the header, rendered only when those flags are true.

## Risks / Trade-offs

- [The glance sentence is copied by hand] → The detail-view test asserts it equals `glanceText` for a syncing snapshot and a paused snapshot.
- [A two-second refresh rebuilds rows and can drop a click] → The toolbar input is not rebuilt while focused. Row replacement is the same full refresh the page already does.
- [Thousands of Proton paths are still downloaded every two seconds] → That is the current snapshot. This change only changes how many rows are in the DOM.
- [`toLocaleString()` depends on the machine's locale] → Tests look for the `<time>` element and the ISO instant, not a particular local spelling.
- [Nested helpers make `applySnapshot` long] → That is the cost of keeping one stringified function. Splitting it would break the browser page or the direct unit call.

## Migration Plan

No stored data and no config change. Reopen the details page after the process restarts. Rollback is reverting the detail-page files. Sync state, the session, and the loopback routes stay either way.

## Open Questions

None. The palette, the page size, and the decision to page on the client are fixed by the spec.
