## Purpose

Automated proof that proton-drive-sync does what its specs and README say: organised unit tests, end-to-end journeys against fakes, crash survival, and a CI gate on the same Node version GitHub Actions uses. The suite is the release brake for a tool that can trash cloud files.

## ADDED Requirements

### Requirement: Layered, colocated organisation
Tests SHALL live next to the module they exercise and SHALL be split by layer using file-name suffixes. Shared fakes and assertions SHALL live only in the testing module. End-to-end journeys SHALL be separate files by story (first sync, daily edits, safety, CLI control, recovery), not one dump file.

#### Scenario: A reader can find the right file
- **WHEN** a contributor looks for unit tests of reconciliation, an engine first-sync journey, or crash-injection
- **THEN** each lives in a distinctly named file under the matching module, and helpers are imported from the shared testing module

#### Scenario: Layers run separately
- **WHEN** a developer runs only unit tests, only end-to-end tests, or only fault-injection tests
- **THEN** each layer is selectable without running the others, and CI runs every layer

### Requirement: Fakes stand in for the outside world
CI and the default local suite SHALL NOT contact a real Proton account, a session D-Bus tray host, or a live Secret Service. Fakes SHALL preserve production contracts: stable node ids, trash not delete, progress callbacks, cursor expiry, Proton-document nodes, and secret-tool exit codes.

#### Scenario: CI has no Proton session
- **WHEN** the full automated suite runs in GitHub Actions
- **THEN** it completes without network calls to Proton and without requiring a logged-in account

#### Scenario: Fake remote matches the contract
- **WHEN** the RemoteDrive contract tests run
- **THEN** they pass against the in-memory fake, including trash-only removal, progress reporting, event-cursor behaviour, and seeding of Proton documents

### Requirement: README journeys run end to end
End-to-end tests against the fake remote and a real temporary local tree SHALL cover the documented user journeys, including the CLI where that is how the user acts. After every journey, user content SHALL still exist locally, remotely, in recycle, or in trash.

#### Scenario: First pair
- **WHEN** the user logs in, sets up a pair, dry-runs, then runs for real with files only on one side each
- **THEN** both sides converge, the dry-run mutates nothing and logs would-do, and the real run does not trash or recycle

#### Scenario: Daily edits both ways
- **WHEN** the engine is running and the user creates, edits, renames, moves, and deletes on each side (local FS and fake “other client”)
- **THEN** the other side matches, deletes go to recycle or trash, and nothing is permanently deleted

#### Scenario: First sync of two non-empty sides
- **WHEN** there is no baseline and both sides already contain files, including the same path with different content
- **THEN** one-sided files are copied, same-path differences become conflicts, and zero files are trashed or recycled

#### Scenario: Conflict, brake, and quarantine through the CLI
- **WHEN** a content conflict, a held mass-change plan, or a quarantined item exists
- **THEN** `conflicts resolve`, `held confirm` / `held reject`, and `quarantine release` through the CLI (and the control socket) actually change engine state the way the README describes

#### Scenario: Recycle list and purge
- **WHEN** a file was recycled and later exceeds retention
- **THEN** `recycle` lists it and `recycle purge` removes only aged entries and logs every purged path

#### Scenario: Session dies while running
- **WHEN** the remote rejects the session during a listing or during a transfer
- **THEN** the engine enters needs-login, does not delete or trash anything, and after a new login in the same process it resumes

#### Scenario: Stop and restart
- **WHEN** the running process is signalled SIGINT or SIGTERM, or a client sends quit, or the process is started again after a crash with in-progress journal rows
- **THEN** the process exits with a consistent journal, a second start recovers before planning, and no user content is lost

### Requirement: Absence is not a delete
The engine SHALL NOT trash remotely or recycle locally because a path disappeared from a partial view: ignored after it was synced, unreadable, replaced by a symlink, missing from an incomplete or empty remote listing, or missing because the local root was replaced or unmounted.

#### Scenario: Ignore after sync
- **WHEN** a previously synced file is added to ignore
- **THEN** it is left untouched on both sides

#### Scenario: Unreadable or symlink after sync
- **WHEN** a previously synced file becomes unreadable or is replaced by a symlink
- **THEN** the remote node is not trashed

#### Scenario: Incomplete or empty remote listing
- **WHEN** the engine has a populated baseline and the remote listing is empty, incomplete, or fails
- **THEN** no remote node is trashed and no local file is recycled as a result of that cycle

#### Scenario: Local root replaced
- **WHEN** the directory at the configured path is a different file-system object than at setup
- **THEN** the engine errors or pauses, executes nothing, and does not treat the tree as deleted

#### Scenario: Pair changed
- **WHEN** setup is pointed at a different remote folder than the existing baseline
- **THEN** the next run is a first sync (no deletes) and the old baseline is not applied to the new folder

### Requirement: Permanent delete APIs stay unwired
Production code SHALL NOT call or expose Proton permanent-delete or empty-trash operations. User files SHALL NOT be unlinked except by the explicit recycle-purge command.

#### Scenario: Source scan
- **WHEN** the source tree is scanned
- **THEN** those SDK methods are absent and a new unlink of user data fails the suite

### Requirement: CI is the release gate
The GitHub Actions workflow SHALL run typecheck, lint, unit tests, end-to-end tests, fault-injection tests, and the production build on Node 24 for every push and pull request. The same steps SHALL pass locally under Node 24. A failure in any step SHALL fail the workflow.

#### Scenario: Push
- **WHEN** a commit is pushed to the GitHub repository that hosts this project
- **THEN** Actions runs the full gate and reports success only if every step passed

#### Scenario: Local reproduction
- **WHEN** a developer runs the documented CI script under Node 24
- **THEN** it executes the same steps as GitHub Actions and exits non-zero on the first failure
