## Purpose

Preserving both versions when the same item changed on both sides, naming them unambiguously, and letting the user decide the outcome instead of the engine picking a winner.

## ADDED Requirements

### Requirement: Conflicts never overwrite
When reconciliation classifies an item as a conflict, the system SHALL keep both versions and SHALL NOT overwrite, trash or recycle either side's version automatically.

#### Scenario: Both sides edited
- **WHEN** a file changed on both sides with different content
- **THEN** both versions exist afterwards and both are visible to the user

### Requirement: Deterministic conflict naming
The system SHALL preserve the remote version under the original name and SHALL save the local version alongside it with a suffix containing the marker "conflict", the machine name, and a timestamp, so that repeated conflicts never collide.

#### Scenario: Conflict copy created
- **WHEN** a content conflict is resolved into two files
- **THEN** the original path holds the remote version and a sibling file with the conflict suffix holds the local version, and the sibling is uploaded so it exists on both sides

#### Scenario: Second conflict on same file
- **WHEN** another conflict occurs on the same path
- **THEN** a new conflict copy with a distinct timestamp is created and no earlier copy is replaced

### Requirement: Delete-versus-edit conflicts keep the edit
When an item was deleted on one side and edited on the other, the system SHALL keep the edited version, SHALL not propagate the delete, and SHALL record the conflict for the user.

#### Scenario: Deleted remotely, edited locally
- **WHEN** the remote copy is gone and the local copy changed
- **THEN** the local copy is re-uploaded as a new file and the event is listed in the conflict inbox

#### Scenario: Deleted locally, edited remotely
- **WHEN** the local copy is gone and the remote copy changed
- **THEN** the remote copy is downloaded again and the event is listed in the conflict inbox

### Requirement: Structural conflicts are surfaced, not guessed
When the same item was moved or renamed to different destinations on both sides, or a folder was deleted on one side while items were created inside it on the other, the system SHALL keep all data, choose no destination automatically, mark the items blocked, and present the options to the user.

#### Scenario: Divergent moves
- **WHEN** an item was moved to path A locally and path B remotely
- **THEN** no move is executed, both locations are reported, and the user picks one

#### Scenario: Create inside deleted folder
- **WHEN** a folder was deleted remotely and a file was created inside it locally
- **THEN** the folder is recreated remotely and the file uploaded; the delete is not propagated

### Requirement: Conflict inbox and resolution
The system SHALL maintain a list of unresolved conflicts with both versions' metadata and SHALL let the user resolve each by keeping local, keeping remote, or keeping both. A resolution SHALL be executed as a normal journaled operation with the non-chosen version recycled or trashed, never permanently deleted.

#### Scenario: Keep remote
- **WHEN** the user chooses "keep remote" for a conflict
- **THEN** the local conflict copy is moved to the recycle directory and its remote copy is trashed

#### Scenario: Keep both
- **WHEN** the user chooses "keep both"
- **THEN** the conflict is marked resolved and both files remain synced as independent items
