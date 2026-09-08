# Data Safety Guards

## Purpose

Hard limits that prevent the engine from destroying or mass-modifying data, regardless of what reconciliation decided: non-destructive deletes, mass-change brakes, quarantine, and preflight checks.

## Requirements

### Requirement: No permanent deletion anywhere
The system SHALL never permanently delete user data. Remote deletes SHALL move nodes to Proton Trash; local deletes and local replacements SHALL move the previous file into a recycle directory inside the sync root's state area, preserving its relative path and a timestamp.

#### Scenario: Local delete
- **WHEN** a local file must be removed because it was deleted remotely
- **THEN** it is moved to the recycle directory and remains restorable

#### Scenario: Local overwrite
- **WHEN** a local file is replaced by a newer remote version
- **THEN** the previous local version is moved to the recycle directory before the new version is put in place

#### Scenario: Recycle retention
- **WHEN** an item in the recycle directory is older than the configured retention period
- **THEN** it is eligible for purge only by an explicit user action or by the retention purge, which logs every purged path

### Requirement: Mass-change brake
The system SHALL halt before executing a plan whose deletes or replacements exceed a configured absolute count or a configured percentage of the baseline, and SHALL require explicit user confirmation to proceed.

#### Scenario: Threshold exceeded
- **WHEN** a plan would delete or replace more items than the threshold
- **THEN** no operation from that plan runs, the engine enters "awaiting confirmation", and the status view shows the affected items

#### Scenario: User confirms
- **WHEN** the user confirms the held plan
- **THEN** the plan is executed as planned and the confirmation is recorded in the audit log

#### Scenario: User rejects
- **WHEN** the user rejects the held plan
- **THEN** the plan is discarded, the affected items are marked for manual review, and syncing of unaffected items continues

### Requirement: First-sync protection
On the very first sync of a non-empty local directory against a non-empty remote folder, the system SHALL never delete on either side and SHALL treat every difference as create or conflict.

#### Scenario: Both sides non-empty at first sync
- **WHEN** no baseline exists and both sides contain items
- **THEN** items present on one side only are copied to the other, and items present on both with different content are treated as conflicts

### Requirement: Quarantine of suspicious items
The system SHALL quarantine an item (exclude it from sync and list it for the user) when its digest verification failed, its remote metadata is inconsistent, it could not be read, or its outcome after a crash was unknown. Quarantined items SHALL never be deleted or overwritten on either side.

#### Scenario: Digest mismatch
- **WHEN** a transfer's verification fails twice
- **THEN** the item is quarantined with the reason

#### Scenario: User releases from quarantine
- **WHEN** the user marks a quarantined item as resolved
- **THEN** it is re-reconciled from scratch on the next cycle

### Requirement: Preflight checks before each cycle
Before executing a plan, the system SHALL verify that the sync root exists and is the same file system object as at configuration time, that the state store is intact, that free disk space exceeds the plan's download volume plus a margin, and that the remote root node identifier matches the configured one.

#### Scenario: Sync root replaced
- **WHEN** the sync root's file system identity differs from the recorded one
- **THEN** the engine pauses with "sync root changed" and executes nothing

#### Scenario: Insufficient disk space
- **WHEN** free space is below the plan's requirement
- **THEN** downloads are held and the engine reports "disk space low"

#### Scenario: Remote root mismatch
- **WHEN** the configured remote root node cannot be found or resolves to a different identifier
- **THEN** the engine pauses with "remote root changed" and executes nothing

### Requirement: Safe defaults
Safety thresholds SHALL default to conservative values and SHALL not be disableable entirely; the lowest permitted brake threshold SHALL still require confirmation for deleting the entire tree.

#### Scenario: Attempt to disable brake
- **WHEN** configuration sets the brake threshold to zero or unlimited
- **THEN** the configuration is rejected with an explanation
