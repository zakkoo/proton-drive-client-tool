# Tray Status Ui

## Purpose

A system tray presence that shows what the engine is doing, surfaces anything that needs the user's attention, and offers the few controls that matter.

## Requirements

### Requirement: Tray icon reflects engine state
The system SHALL show a tray icon whose appearance distinguishes at least: idle (in sync), scanning, syncing, paused, offline, throttled/degraded, needs attention (conflicts or quarantine), awaiting confirmation (brake), and error (including needs login).

#### Scenario: State change
- **WHEN** the engine changes state
- **THEN** the icon and its tooltip update within a few seconds

#### Scenario: Attention required
- **WHEN** there is at least one unresolved conflict, quarantined item, or held plan
- **THEN** the icon shows the attention state until the user has acted

### Requirement: Status panel
Opening the tray SHALL show: current state and its reason, last successful full sync time, counts of pending uploads and downloads, the list of in-flight transfers with file name, direction, progress and speed, and the count of items needing attention.

#### Scenario: Syncing
- **WHEN** transfers are running
- **THEN** each transfer appears with live progress and the totals update as items complete

#### Scenario: Idle
- **WHEN** nothing is pending
- **THEN** the panel shows "in sync" with the time of the last successful cycle

### Requirement: Conflict inbox and quarantine views
The tray SHALL provide views listing unresolved conflicts and quarantined items, each with both versions' metadata and the reason, and SHALL offer the resolution actions defined by conflict handling and safety guards.

#### Scenario: Resolve from tray
- **WHEN** the user picks a resolution for a conflict in the tray
- **THEN** the resolution is handed to the engine and the item disappears from the inbox once executed

### Requirement: Held plan confirmation
When the engine is awaiting confirmation for a mass change, the tray SHALL show the list of items that would be deleted or replaced and SHALL offer "proceed" and "reject" actions.

#### Scenario: Review held plan
- **WHEN** a plan is held by the mass-change brake
- **THEN** the user can see every affected path before deciding

### Requirement: Controls
The tray SHALL offer pause/resume, "sync now", open sync folder, open recycle folder, open log, open settings, and quit. Quit SHALL stop the engine cleanly at an operation boundary.

#### Scenario: Pause
- **WHEN** the user selects pause
- **THEN** the engine enters paused state and the icon reflects it

#### Scenario: Quit during transfer
- **WHEN** the user quits while a transfer is running
- **THEN** the transfer is cleanly aborted or completed, the journal is consistent, and the process exits

### Requirement: Notifications for events needing attention
The system SHALL emit a desktop notification when a conflict is created, an item is quarantined, a plan is held, login is required, or the engine enters error state. Routine sync activity SHALL not produce notifications.

#### Scenario: New conflict
- **WHEN** a conflict is created
- **THEN** one notification is shown naming the file

### Requirement: Tray unavailable does not stop sync
If no tray host is available, the engine SHALL continue running and SHALL expose the same status through a command-line status command.

#### Scenario: No tray host
- **WHEN** the desktop offers no tray
- **THEN** sync continues and the status command returns the same information the panel would show
