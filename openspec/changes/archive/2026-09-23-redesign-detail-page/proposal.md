## Why

Open details is a localhost page that dumps the whole sync snapshot into one plain document: a run-on status paragraph, raw JSON for conflicts, and unbounded lists. A library with thousands of Proton documents becomes a page you cannot scan. The page should read like the preview card and stay usable when those lists grow, while pause, sync, conflict resolution, and every other engine action stay exactly what they are today.

## What Changes

- Restyle the details page only: a mint-to-lavender canvas, white rounded panels, navy text, and the cyan and folder-blue accents sampled from the root preview card (`preview.jpg`; there is no `preview.png` in the tree). Vanilla CSS, no framework.
- Keep the page's TypeScript inside the existing detail-page module. The loopback server, its token, its JSON snapshot, and its action routes stay. The engine, tray menu, bar, CLI wording, and sync rules stay.
- Show the same facts in a scannable layout: state first, the human last-sync and library lines as separate sentences, items that need a decision above the long lists, and a compact empty line where a section has nothing.
- Page every long list at 25 rows, with a path filter. Proton documents, conflicts, quarantine, the recycle bin, in-flight transfers, and the paths on a held plan all use it. Two Proton documents still appear together with no extra click. A refresh keeps the page and the filter the user already chose.
- Keep every conflict field reachable (a short summary, with the full JSON on demand) and keep Keep local, Keep remote, Keep both, Release, Proceed, and Reject.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tray-status-ui`: The details page gains the preview-card look and client-side paging and filtering. The live snapshot, the control actions, and the rule that the tray, the bar, and human CLI status do not list Proton document paths stay.

## Impact

- `src/tray/detailPage.ts` (the served document and its CSS) and `src/tray/detailView.ts` (the DOM renderer and the in-page script), plus their tests.
- No new dependency. No change to `/api/state`, the POST actions, engine state, or files outside the detail page.
