## Purpose

An append-only, human-readable record of every decision and action so the history of any file can be reconstructed and any incident investigated.

## ADDED Requirements

### Requirement: Log every decision and action
The system SHALL append a structured entry for every planned operation (with its evidence), every executed operation (with outcome), every safety brake, quarantine, conflict, recovery step, and every user confirmation or resolution.

#### Scenario: Operation executed
- **WHEN** an operation completes or fails
- **THEN** an entry records the timestamp, operation kind, local path, remote node identifier, digests before and after where applicable, and the outcome

#### Scenario: Safety event
- **WHEN** a brake, quarantine or preflight failure occurs
- **THEN** an entry records the trigger, the affected items, and the resulting engine state

### Requirement: Append-only and rotated
Log files SHALL be append-only during operation, SHALL be rotated by size or date, and rotated files SHALL be retained for a configurable period before deletion.

#### Scenario: Rotation
- **WHEN** the active log exceeds the configured size
- **THEN** it is closed, renamed with a timestamp, and a new active log is started without losing entries

### Requirement: No secrets in logs
Log entries SHALL never contain passwords, session tokens, key material, or decrypted file contents.

#### Scenario: Authentication error logged
- **WHEN** a login or session error is logged
- **THEN** the entry contains the error category and message but no token or password

### Requirement: Per-file history query
The system SHALL provide a way to list all log entries concerning a given local path or remote node identifier in chronological order.

#### Scenario: Investigate a file
- **WHEN** the user asks for the history of a path
- **THEN** every entry referencing that path or its node identifier is returned, including renames under earlier paths

### Requirement: Machine-readable format
Each entry SHALL be a single line of structured data that can be parsed by standard tools and SHALL also be readable by a person without tooling.

#### Scenario: Parse with standard tools
- **WHEN** the log is read line by line
- **THEN** each line parses as a self-contained record with consistent field names
