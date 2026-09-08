# Sync Execution

## Purpose

Journaled, verified, crash-resumable execution of a reconciliation plan so that no operation is ever half-applied and the baseline is only updated after both sides are confirmed.

## Requirements

### Requirement: Write-ahead journaling of every mutation
Before performing any operation that changes local or remote state, execution SHALL record the operation and its intended outcome in the journal. After the operation, the journal entry SHALL be marked completed or failed. The baseline SHALL be updated only within the completion step.

#### Scenario: Normal operation
- **WHEN** an operation is executed
- **THEN** the journal shows planned, then in-progress, then completed, and the baseline reflects the outcome only at completion

#### Scenario: Operation fails
- **WHEN** the operation returns an error
- **THEN** the journal entry is marked failed with the error, the baseline is not updated, and the item is re-evaluated in the next cycle

### Requirement: Recovery on startup
On startup, before any new plan is executed, execution SHALL examine every in-progress journal entry, SHALL check both sides to determine whether the operation took effect, and SHALL either complete, roll back, or mark it abandoned. No new operations SHALL run until recovery finishes.

#### Scenario: Crash after upload, before completion
- **WHEN** the journal shows an upload in progress and the remote already holds a revision with the expected digest
- **THEN** the entry is completed and the baseline is updated without re-uploading

#### Scenario: Crash during download
- **WHEN** the journal shows a download in progress and a temporary file exists
- **THEN** the temporary file is removed, the entry is marked failed, and the download is replanned

#### Scenario: Unknown outcome
- **WHEN** the outcome cannot be determined from either side
- **THEN** the entry is marked abandoned, the item is flagged for re-reconciliation, and nothing is deleted

### Requirement: Atomic local writes
Execution SHALL write downloaded content to a temporary file inside the same file system, verify its digest, set its modification time, and then atomically rename it into place. The previous version, if any, SHALL be moved to the recycle directory before the rename, not overwritten.

#### Scenario: Successful download
- **WHEN** a download completes verification
- **THEN** the target path atomically switches from old content to new content and the old content is in the recycle directory

#### Scenario: Local file changed during download
- **WHEN** the local target's inode, size or modification time changed between planning and rename
- **THEN** the rename is aborted, the temporary file is kept aside, and the item is re-reconciled as a potential conflict

#### Scenario: Disk full
- **WHEN** the temporary file cannot be fully written
- **THEN** the temporary file is removed, the target is untouched, and the engine pauses with a "disk full" condition

### Requirement: Verify before recording success
Execution SHALL confirm, after every transfer, that the destination side reports the expected digest and size before marking the journal entry completed.

#### Scenario: Upload verified
- **WHEN** the remote active revision reports the expected digest and size
- **THEN** the entry is completed

#### Scenario: Verification mismatch
- **WHEN** the destination reports a different digest or size
- **THEN** the entry is marked failed, the item is quarantined, and the engine reports the mismatch

### Requirement: Preconditions checked at execution time
Immediately before applying an operation, execution SHALL re-check that the affected item on each side still matches the state the plan was based on. If it does not, the operation SHALL be skipped and the item replanned.

#### Scenario: Remote changed since planning
- **WHEN** the remote node's revision differs from the one recorded in the plan
- **THEN** the operation is skipped and the item is re-reconciled

#### Scenario: Local file modified since planning
- **WHEN** the local file's modification time or size differs from the plan
- **THEN** the upload is skipped and the item is re-reconciled

### Requirement: Bounded concurrency and cancellation
Execution SHALL run transfers with a configurable concurrency limit, SHALL allow pause and cancel at operation boundaries, and SHALL leave no partially applied state when cancelled.

#### Scenario: Pause requested
- **WHEN** the user pauses during a batch
- **THEN** in-flight transfers complete or are cleanly aborted, no new operations start, and the journal is consistent

#### Scenario: Cancel mid-download
- **WHEN** a download is cancelled
- **THEN** its temporary file is removed and the target is untouched

### Requirement: Retry with idempotency
Execution SHALL retry transient failures with backoff up to a configured limit, SHALL re-check the destination before each retry of a mutating operation, and SHALL give up into a failed state rather than retrying indefinitely.

#### Scenario: Transient network failure
- **WHEN** an upload fails with a network error
- **THEN** it is retried after backoff, after confirming the remote does not already hold the expected revision

#### Scenario: Retry limit reached
- **WHEN** the retry limit is exhausted
- **THEN** the operation is marked failed and surfaced in the status view

### Requirement: Dry-run execution
When dry-run mode is enabled, execution SHALL record every operation it would perform in the audit log and SHALL make no change to local files, remote nodes, or the baseline.

#### Scenario: Dry run
- **WHEN** dry-run is enabled and a plan contains operations
- **THEN** the operations appear in the audit log as "would do" and nothing on either side changes
