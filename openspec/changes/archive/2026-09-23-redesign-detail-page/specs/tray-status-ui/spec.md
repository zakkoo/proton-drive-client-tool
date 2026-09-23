## MODIFIED Requirements

### Requirement: Detail page is a live view
The details page SHALL be served only on 127.0.0.1 behind a per-run secret in the URL, SHALL load the live snapshot into the visible page (not only into a JSON endpoint), SHALL refresh while open, and SHALL offer pause, resume, sync now, conflict resolution, quarantine release, and held-plan confirm/reject. A successful load of a running engine SHALL never render an empty shell with no state, counts, or lists when the engine has data. The visible page SHALL show the human last-sync, last-full-sync, and library lines, and SHALL NOT show `N local · N remote · N synced`. When Proton documents exist, the page SHALL make every relative path reachable. A list of 25 or fewer paths SHALL be fully visible without changing pages. A longer list SHALL show 25 paths per page and SHALL let the user open the other pages. The tray, the bar panel, and human CLI status SHALL NOT list those paths. Pause, resume, sync now, conflict resolution, quarantine release, and held-plan confirm or reject SHALL keep their current effect on the engine.

#### Scenario: Open details with files already synced
- **WHEN** the user opens the details page after a successful sync of a non-empty tree with no Proton documents
- **THEN** the visible page shows the engine state, a `Last sync` line, a files line, and is not blank, and it does not show a Proton document path

#### Scenario: Proton documents are listed
- **WHEN** the snapshot includes two Proton documents at `Notes/Agenda` and `Notes/Budget`
- **THEN** the details page shows both paths without requiring a page change, and human CLI status shows the Proton documents count without either path

#### Scenario: A long Proton document list is paged
- **WHEN** the snapshot includes 30 Proton document paths
- **THEN** the page shows 25 of them, shows that 30 exist, and the remaining 5 are visible after moving to the next page

#### Scenario: Pause from the page
- **WHEN** the user clicks Pause on the details page
- **THEN** the engine enters paused, the page's displayed state becomes paused, and subsequent local creates are not uploaded until Resume

#### Scenario: Unknown token
- **WHEN** a client requests the page or its API with a token that is not the current run's token
- **THEN** the server responds not found and does not leak status

## ADDED Requirements

### Requirement: Detail page matches the preview card
The details page SHALL paint itself with the preview card's colors: mint `#cdfae4` into lavender `#d0d8fc` across the page, white cards `#fcfdfe`, navy text `#2c3343`, cyan `#2cd1ec`, and folder blue `#42aefc`. Cards and controls SHALL be rounded. The page SHALL carry that presentation in the document it serves and SHALL NOT load a script or a stylesheet from another host. Each human reading line SHALL be its own block, so the sentences do not run together. While a file run has a `done` and `total`, the page header SHALL also show the same glance string the bar uses (`Sync (done/total)` or `Paused (done/total)`), and the last-sync line SHALL stay. When `dryRun` is true the page SHALL say dry run. When `degraded` is true the page SHALL say the event stream is degraded.

#### Scenario: The served page carries the card colors
- **WHEN** the browser loads the details page
- **THEN** the document includes `#cdfae4`, `#d0d8fc`, `#fcfdfe`, `#2c3343`, `#2cd1ec`, and `#42aefc`, and its panels are rounded

#### Scenario: Reading lines stay separate
- **WHEN** the snapshot has a last-sync line and a files line
- **THEN** each line is in its own block and both sentences are visible

#### Scenario: A file run shows the glance and the previous sync
- **WHEN** the engine is syncing with `done` 34 and `total` 5685, and the previous finished check copied 2 files
- **THEN** the page shows `Sync (34/5685)` and the last-sync line still says `2 files copied`

### Requirement: Detail page keeps long lists compact
Proton documents, conflicts, quarantine, the recycle bin, in-flight transfers, and the affected paths of a held plan SHALL each show at most 25 rows at a time. The section heading SHALL show the full count. The user SHALL be able to filter a section by a case-insensitive path substring and SHALL be able to move between pages of the filtered rows. A filter that matches nothing SHALL say that nothing matches and SHALL still show the unfiltered count. Clearing the filter SHALL show the full list again, from its first page. A refresh of the live snapshot SHALL keep the current page and the current filter, and SHALL move back only when the current page no longer exists. An empty section SHALL be one compact line that contains `none`. Conflicts, quarantine, and a held plan SHALL appear above Proton documents and the recycle bin. A conflict SHALL show a short summary of the local and remote sides and SHALL still reveal the full JSON without leaving the page, along with Keep local, Keep remote, and Keep both. A recycle row SHALL show a readable local time and the ISO instant. A failed page action SHALL show the error text returned for that action.

#### Scenario: Filter a long document list
- **WHEN** 30 Proton document paths are listed and the user filters for `agenda`
- **THEN** only paths that contain that substring are shown, the heading still shows 30, and clearing the filter returns the full list at its first page

#### Scenario: Refresh keeps the user's place
- **WHEN** the user is on page 2 of Proton documents with a filter applied and the live snapshot refreshes
- **THEN** the page stays on page 2 and the filter text is unchanged

#### Scenario: Empty quarantine stays one line
- **WHEN** the snapshot has no quarantined items
- **THEN** the quarantine section is a single compact line containing `none`

#### Scenario: Decisions sit above the library lists
- **WHEN** there is an open conflict and at least one Proton document
- **THEN** the conflict, including its path and the three resolve actions, is above the Proton documents section

#### Scenario: Conflict JSON stays available
- **WHEN** a conflict has local and remote records
- **THEN** a short summary is visible, and the full JSON of both records can be opened on the page

#### Scenario: A rejected action is visible
- **WHEN** a page action returns an error message
- **THEN** that message is shown on the page and the engine state is left as the action left it
