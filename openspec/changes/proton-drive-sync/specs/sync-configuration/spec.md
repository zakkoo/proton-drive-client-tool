## Purpose

How the user configures what is synced, where, with which safety limits, and how credentials are kept.

## ADDED Requirements

### Requirement: Configure sync pair
The user SHALL be able to configure exactly one local sync root and one remote folder path. The system SHALL validate that the local root exists and is writable and that the remote folder exists, and SHALL record the remote folder's node identifier and the local root's file system identity at setup time.

#### Scenario: Valid setup
- **WHEN** the user provides an existing local directory and an existing remote folder
- **THEN** the configuration is saved with the resolved identifiers and the first sync can begin

#### Scenario: Local root inside another sync tool's folder or a system directory
- **WHEN** the chosen local root is the home directory, root, or a path already configured
- **THEN** the setup is rejected with an explanation

### Requirement: Ignore patterns
The user SHALL be able to configure ignore patterns using glob syntax, and the system SHALL ship a default set covering editor temporary files, OS metadata files, and its own directories.

#### Scenario: Add pattern
- **WHEN** the user adds an ignore pattern
- **THEN** matching items stop being synced on the next cycle and existing synced copies are left untouched on both sides

### Requirement: Safety thresholds and retention
The user SHALL be able to configure the mass-change brake count and percentage, recycle retention days, log retention days, and transfer concurrency, within permitted bounds.

#### Scenario: Out-of-bounds value
- **WHEN** a value is outside the permitted range
- **THEN** it is rejected and the previous value remains in effect

### Requirement: Credentials in the OS secret store
Session tokens and the key password SHALL be stored only in the OS secret store under a service name specific to this application. The configuration file SHALL contain no secrets.

#### Scenario: Inspect configuration file
- **WHEN** the configuration file is read
- **THEN** it contains paths, patterns and thresholds but no tokens or passwords

#### Scenario: Secret store unavailable
- **WHEN** the OS secret store cannot be reached
- **THEN** the system reports the problem and does not fall back to plaintext storage without an explicit, clearly labelled opt-in

### Requirement: Configuration changes take effect safely
Changing the local root or remote folder SHALL require re-running setup and SHALL start a fresh baseline; the previous baseline and recycle directory SHALL be preserved. Other settings SHALL take effect at the next cycle boundary.

#### Scenario: Change remote folder
- **WHEN** the user changes the remote folder
- **THEN** the engine stops, the old state is archived, and a new first sync with first-sync protection begins

### Requirement: Dry-run and pause flags
The user SHALL be able to enable dry-run mode and to start the application paused, from both configuration and command line.

#### Scenario: Start in dry-run
- **WHEN** dry-run is enabled
- **THEN** the tray shows a visible dry-run indicator and no changes are made on either side
