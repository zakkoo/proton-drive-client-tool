# Sync Reconciliation

## Purpose

The pure decision engine that compares the baseline, the current local snapshot and the current remote snapshot and produces a plan of operations, classifying every difference as a safe action, a conflict, or a blocked action.

## Requirements

### Requirement: Decisions are pure and deterministic
Reconciliation SHALL be a side-effect-free function of three inputs (baseline, local snapshot, remote snapshot) plus configuration, SHALL produce the same plan for the same inputs, and SHALL perform no I/O.

#### Scenario: Same inputs
- **WHEN** reconciliation is run twice with identical inputs
- **THEN** it produces identical plans

#### Scenario: Plan is inspectable
- **WHEN** a plan is produced
- **THEN** every planned operation carries the evidence it was based on (which fields differed on which side relative to baseline)

### Requirement: Three-way comparison per item
For every item present in any of the three inputs, reconciliation SHALL determine whether each side is unchanged, changed, created, moved or deleted relative to the baseline, and SHALL derive the action from that pair of side states.

#### Scenario: Changed on one side only
- **WHEN** an item differs from baseline on exactly one side
- **THEN** the plan propagates that change to the other side

#### Scenario: Unchanged on both sides
- **WHEN** both sides match the baseline
- **THEN** no operation is planned for the item

#### Scenario: Identical change on both sides
- **WHEN** both sides changed and now carry the same content digest (or both are deleted)
- **THEN** no transfer is planned and the baseline is updated to the new common state

#### Scenario: Different change on both sides
- **WHEN** both sides changed relative to baseline and differ from each other
- **THEN** the item is classified as a conflict and handed to conflict handling; no overwrite is planned

### Requirement: Content equality by digest, not by time alone
Reconciliation SHALL treat two file versions as identical only when their content digests match. Modification time and size SHALL be used only as a fast path to decide whether a digest must be recomputed.

#### Scenario: Same time, different content
- **WHEN** local and remote report the same modification time and size but different digests
- **THEN** the item is treated as changed

#### Scenario: Different time, same content
- **WHEN** modification times differ but digests are equal
- **THEN** no transfer is planned and only metadata is reconciled

### Requirement: Rename and move detection
Reconciliation SHALL recognize an item that disappeared at one path and appeared at another with the same identity (remote node identifier, or local inode with matching digest) as a move, and SHALL plan a rename/move on the other side rather than delete plus re-transfer.

#### Scenario: Remote move
- **WHEN** a remote node's parent or name changed and its identifier and content are unchanged
- **THEN** the plan moves the local file to the corresponding path

#### Scenario: Local move
- **WHEN** a local file's path changed but its inode and digest match the baseline
- **THEN** the plan moves the remote node

#### Scenario: Move plus edit
- **WHEN** an item was moved and its content changed on the same side
- **THEN** the plan performs the move and then the content update, in that order

#### Scenario: Folder move
- **WHEN** a folder is moved
- **THEN** a single move is planned for the folder, and its descendants are not individually re-transferred

### Requirement: Deletion is propagated only with baseline evidence
Reconciliation SHALL plan a delete on one side only when the item existed in the baseline, is now absent on the other side, and is unchanged on the side to be deleted. If the item to be deleted has changed since baseline, it SHALL be classified as a conflict instead.

#### Scenario: Deleted remotely, unchanged locally
- **WHEN** an item in the baseline is absent from the remote snapshot and the local copy matches the baseline
- **THEN** the plan moves the local copy to the recycle directory

#### Scenario: Deleted remotely, modified locally
- **WHEN** an item in the baseline is absent remotely but the local copy changed
- **THEN** the item is classified as a conflict and the local copy is not deleted

#### Scenario: Missing on one side with no baseline
- **WHEN** an item exists on one side only and has no baseline record
- **THEN** it is treated as newly created and is transferred, never deleted

### Requirement: Dependency ordering of operations
The plan SHALL order operations so that parents exist before children, moves out of a folder precede that folder's deletion, and content updates follow structural changes to the same item.

#### Scenario: New folder with files
- **WHEN** a new folder containing files must be created on one side
- **THEN** the folder creation is ordered before its children's uploads or downloads

#### Scenario: Folder deleted with moved child
- **WHEN** a folder is deleted but one of its children was moved elsewhere
- **THEN** the child's move is ordered before the folder's deletion

### Requirement: Case and name normalization
Reconciliation SHALL detect names that differ only by case or Unicode normalization form and names that are invalid on one side, and SHALL classify them as blocked with an explanation rather than guessing a mapping.

#### Scenario: Case-only collision
- **WHEN** two remote siblings differ only by letter case
- **THEN** both are marked blocked and neither is downloaded until the user resolves the naming

### Requirement: Snapshot completeness gate
Reconciliation SHALL refuse to produce a plan containing deletes when either snapshot is marked incomplete, unavailable, or empty while the baseline is non-empty.

#### Scenario: Remote root reads as empty
- **WHEN** the remote snapshot contains zero items but the baseline contains items
- **THEN** no local deletes are planned and the engine enters the "awaiting confirmation" state

#### Scenario: Local root unavailable
- **WHEN** the local snapshot is flagged as root unavailable
- **THEN** no remote trash operations are planned
