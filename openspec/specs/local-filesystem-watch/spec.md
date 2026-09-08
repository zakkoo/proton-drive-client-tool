# Local Filesystem Watch

## Purpose

Observing the local sync root so that every create, modify, rename, move and delete is detected reliably, with periodic full scans as a safety net against missed events.

## Requirements

### Requirement: Detect local changes in near real time
The system SHALL watch the sync root recursively and SHALL detect file and folder creation, content modification, rename, move and deletion within a short, configurable debounce window.

#### Scenario: File created
- **WHEN** a new file appears under the sync root and stops changing for the debounce window
- **THEN** a "created" change with its path, size, modification time and inode is emitted

#### Scenario: File modified
- **WHEN** an existing file's content changes and it stops changing for the debounce window
- **THEN** a single "modified" change is emitted, not one per write

#### Scenario: Folder created with contents
- **WHEN** a folder containing files is moved into the sync root
- **THEN** the folder and every descendant are detected, including descendants created before the watch on the new folder was established

### Requirement: Detect renames and moves as such
The system SHALL identify a rename or move within the sync root as a single "moved" change carrying old and new path, using inode identity and content digest as evidence, rather than as a delete followed by a create.

#### Scenario: Rename in same folder
- **WHEN** a file is renamed
- **THEN** a "moved" change with old and new path is emitted and its inode is unchanged

#### Scenario: Move across folders
- **WHEN** a file or folder is moved to another folder inside the sync root
- **THEN** a "moved" change is emitted for the item (and folder moves cover all descendants)

#### Scenario: Ambiguous evidence
- **WHEN** a delete and a create are observed but inode and digest evidence do not agree
- **THEN** the change is emitted as separate delete and create, and the ambiguity is noted so reconciliation can apply delete safety rules

### Requirement: Periodic full scan reconciles missed events
The system SHALL perform a full scan of the sync root at a configurable interval and on startup, SHALL compare it with the last known local snapshot, and SHALL emit changes for any difference not already observed through events.

#### Scenario: Event missed while running
- **WHEN** a file changed but no event was delivered
- **THEN** the next full scan detects the difference by modification time, size or digest and emits the change

#### Scenario: Changes while not running
- **WHEN** the system starts after being offline
- **THEN** a full scan runs before any sync decisions are made

### Requirement: Ignore rules
The system SHALL exclude paths matching configured ignore patterns and SHALL always exclude its own temporary, recycle and state directories. Ignored items SHALL never be uploaded, and their absence remotely SHALL never cause a local delete.

#### Scenario: Ignored file created
- **WHEN** a file matching an ignore pattern is created
- **THEN** no change is emitted for it

#### Scenario: Internal directories
- **WHEN** the system writes temporary or recycle files under the sync root
- **THEN** those writes do not generate changes

### Requirement: Handle unreadable and special files safely
The system SHALL report files it cannot read, symbolic links, device files, sockets and files with names not representable remotely as "unsyncable" and SHALL exclude them without altering them.

#### Scenario: Permission denied
- **WHEN** a file under the sync root cannot be read
- **THEN** it is reported as unsyncable with the reason and is not deleted or renamed

#### Scenario: Symbolic link
- **WHEN** a symbolic link is encountered
- **THEN** it is reported as unsyncable and neither the link nor its target is synced

### Requirement: Detect sync root problems
The system SHALL detect when the sync root becomes unavailable (unmounted, deleted, permission lost) and SHALL emit a "root unavailable" condition instead of a stream of deletes.

#### Scenario: Sync root disappears
- **WHEN** the sync root directory no longer exists or cannot be listed
- **THEN** a "root unavailable" condition is emitted and no per-file delete changes are emitted
