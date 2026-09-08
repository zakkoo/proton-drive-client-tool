# Sync State Store

## Purpose

A durable, crash-safe record of the last known synced state of every item on both sides, which every sync decision is compared against.

## Requirements

### Requirement: Persist baseline for every synced item
The system SHALL store for every synced item: the local relative path, local inode, local size, local modification time, local SHA1, the remote node identifier, remote parent identifier, remote name, remote active revision identifier, remote SHA1, and the time the item was last confirmed in sync.

#### Scenario: Item confirmed in sync
- **WHEN** an operation completes and both sides are verified identical
- **THEN** the item's baseline is updated with both sides' current metadata in a single atomic write

#### Scenario: Lookup by any key
- **WHEN** reconciliation needs an item by local path, by inode, or by remote node identifier
- **THEN** the store returns the same record regardless of which key is used

### Requirement: Durable across crashes
The state store SHALL survive process crashes and power loss without corruption or partially applied updates, and SHALL be verified for integrity on every startup.

#### Scenario: Crash during write
- **WHEN** the process is killed while a baseline update is being written
- **THEN** on restart the store contains either the complete old record or the complete new record, never a mix

#### Scenario: Corruption detected
- **WHEN** the integrity check fails on startup
- **THEN** the system refuses to start syncing, keeps the corrupt file for inspection, and requires the user to choose rebuild-from-scratch (which treats all items as new and never deletes)

### Requirement: Store operation journal
The store SHALL hold the write-ahead operation journal used by sync execution, including each operation's kind, target identifiers, intended outcome, and status (planned, in-progress, completed, failed, abandoned).

#### Scenario: Journal survives restart
- **WHEN** the process restarts with in-progress journal entries
- **THEN** those entries are available to execution for completion or verification before any new plan is made

### Requirement: Store remote event cursor and scan timestamps
The store SHALL persist the last processed remote event cursor per event scope and the time of the last successful full local and remote scan.

#### Scenario: Cursor persisted after processing
- **WHEN** a remote event has been applied to the remote snapshot
- **THEN** its cursor is persisted so that after a restart the same event is not processed as new

### Requirement: Schema versioning and migration
The store SHALL carry a schema version and SHALL refuse to open a store from a newer version. Migrations SHALL be applied in a transaction and a backup of the previous store SHALL be kept until the migrated store has completed one successful sync cycle.

#### Scenario: Newer schema encountered
- **WHEN** the store was written by a newer version of the software
- **THEN** the system refuses to start and reports the version mismatch

#### Scenario: Migration failure
- **WHEN** a migration step fails
- **THEN** the store is left in its pre-migration state and the backup is untouched

### Requirement: Exclusive access
The store SHALL be opened by at most one running instance. A second instance SHALL detect the lock and exit without touching data.

#### Scenario: Second instance started
- **WHEN** the application is launched while another instance holds the store
- **THEN** the second instance reports "already running" and exits
