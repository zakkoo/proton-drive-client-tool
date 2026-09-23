# Remote Drive Access

## Purpose

Authenticated, verified access to the user's Proton Drive tree: reading node metadata with stable identifiers, transferring content, applying structural changes, and consuming the remote change stream.

## Requirements

### Requirement: Authenticate with Proton account
The system SHALL authenticate against the user's Proton account using an official login flow: by default the browser session-fork flow (Proton's web login handles password and second factor and hands back a forked session plus an encrypted key password), with the SRP password-proof flow (including TOTP) as a fallback for terminals without a browser. It SHALL persist the resulting session and key password only in the OS secret store. The password SHALL never be written to disk or to any log.

#### Scenario: First login
- **WHEN** the user runs the login command and completes the browser login (or supplies valid credentials and a second factor with `--password`)
- **THEN** the system obtains a session, stores it in the OS secret store under its own service name, and reports success without echoing any secret

#### Scenario: Session reuse
- **WHEN** the system starts and a stored session exists
- **THEN** it resumes that session without prompting for credentials

#### Scenario: Session expired or revoked
- **WHEN** the remote rejects the stored session
- **THEN** the system transitions to the "needs login" state, stops all remote operations, does not delete or modify any local or remote data, and surfaces the condition to the user

### Requirement: Read the remote tree with stable identifiers
The system SHALL list folders and files under the configured remote root and SHALL expose for every node: a stable node identifier that survives rename and move, parent identifier, name, type, modification time, size, and for files the SHA1 content digest and active revision identifier when available.

#### Scenario: Listing a folder
- **WHEN** the system lists a remote folder
- **THEN** it receives every direct child with the fields above and no child is silently omitted

#### Scenario: Node whose name cannot be decrypted
- **WHEN** a node's name cannot be decrypted or verified
- **THEN** the node is reported as undecryptable, excluded from sync, and recorded in the audit log; it is never deleted or renamed

### Requirement: Download file content with verification
The system SHALL download the active revision of a file and SHALL verify its SHA1 digest against the claimed digest when one is available. Downloaded bytes SHALL be written to a temporary location and only exposed to the caller after verification succeeds.

#### Scenario: Digest matches
- **WHEN** a download completes and the computed SHA1 equals the claimed SHA1
- **THEN** the content is delivered to the caller as verified

#### Scenario: Digest mismatch
- **WHEN** the computed SHA1 differs from the claimed SHA1
- **THEN** the temporary content is discarded, the download is reported as failed with a verification error, and nothing on disk or remote is changed

#### Scenario: No claimed digest available
- **WHEN** the remote revision carries no SHA1 claim
- **THEN** the download is delivered but flagged as "unverified against source", and the local SHA1 is recorded for future comparisons

### Requirement: Upload file content as new file or new revision
The system SHALL upload a local file either as a new remote file or as a new revision of an existing remote node, SHALL include the local modification time and SHA1 in the upload metadata, and SHALL confirm after upload that the remote active revision reports the expected SHA1 and size.

#### Scenario: New file upload
- **WHEN** a local file has no corresponding remote node
- **THEN** it is uploaded as a new file under the correct remote parent and the returned node identifier is handed back to the caller

#### Scenario: Update existing file
- **WHEN** a local file corresponds to an existing remote node
- **THEN** it is uploaded as a new revision of that node, preserving the node identifier and the previous revision

#### Scenario: Post-upload verification fails
- **WHEN** the remote metadata after upload does not match the uploaded SHA1 or size
- **THEN** the upload is reported as failed and the caller does not record success

#### Scenario: Interrupted upload
- **WHEN** the connection drops mid-upload
- **THEN** no partial file becomes the active revision and the operation is reported as retryable

### Requirement: Rename and move remote nodes
The system SHALL rename a node in place and SHALL move nodes to a new parent without changing their node identifier or content.

#### Scenario: Rename
- **WHEN** a rename is requested with a valid new name
- **THEN** the node keeps its identifier and revision and only its name changes

#### Scenario: Move
- **WHEN** a move to another folder is requested
- **THEN** the node keeps its identifier and revision and only its parent changes

#### Scenario: Target name already exists
- **WHEN** the target parent already contains a node with the requested name
- **THEN** the operation fails with a name-conflict error and no node is replaced or trashed

### Requirement: Trash remote nodes, never permanently delete
The system SHALL move remote nodes to Proton Trash when a delete is required. The system SHALL NOT permanently delete nodes or empty the trash.

#### Scenario: Trash a node
- **WHEN** a remote delete is required
- **THEN** the node is moved to Trash and remains restorable by the user

#### Scenario: Permanent delete requested
- **WHEN** any component requests a permanent delete or empty-trash
- **THEN** the request is refused and logged as a safety violation

### Requirement: Consume remote change events
The system SHALL subscribe to the remote change stream for the synced volume, SHALL persist the last processed event cursor, and SHALL resume from that cursor after restart. When the remote signals that the cursor is too old or a full refresh is required, the system SHALL perform a full listing instead of guessing.

#### Scenario: Incremental events
- **WHEN** nodes are created, updated, moved, trashed or deleted remotely
- **THEN** the system receives corresponding events identifying the node and its parent and passes them to reconciliation

#### Scenario: Cursor expired
- **WHEN** the remote reports the stored cursor is no longer valid
- **THEN** the system performs a complete listing of the remote root, rebuilds its remote snapshot, and stores the new cursor

#### Scenario: Event stream unavailable
- **WHEN** events cannot be received for longer than a configured interval
- **THEN** the system falls back to a periodic full listing and reports "degraded" status

### Requirement: Respect rate limits and transient failures
The system SHALL treat throttling and 5xx responses as retryable with exponential backoff and jitter, SHALL treat 4xx responses other than throttling as permanent for that operation, and SHALL never retry a mutating operation without first checking whether it already took effect.

#### Scenario: Throttled
- **WHEN** the remote signals throttling
- **THEN** the system pauses requests for the indicated period and reports "throttled" status

#### Scenario: Retrying a mutation after timeout
- **WHEN** a mutating request timed out with unknown outcome
- **THEN** the system re-reads the affected node before deciding whether to retry, so the mutation is applied at most once

### Requirement: Bound Proton API response bodies
The system SHALL read Proton JSON response bodies, including success bodies, error bodies, and session-refresh bodies, with a fixed ceiling of 16 MiB (16 × 1024 × 1024 bytes). The ceiling SHALL be enforced by counting bytes as they arrive, including when `Content-Length` is absent or smaller than the body that follows. The system SHALL stop reading once the next byte would pass the ceiling, SHALL NOT parse a partial body, and SHALL fail with an error whose message and structured details contain no bytes from the response. A body of exactly 16 MiB SHALL be accepted. The ceiling SHALL NOT be a user-facing setting.

Successful file-content downloads SHALL NOT be subject to this ceiling. A file larger than 16 MiB SHALL still download. An error body on a file-content request SHALL use the same ceiling and SHALL NOT be written as file content.

For every JSON body at or under the ceiling, the system SHALL keep the current parse, retry, and throttle behaviour. A Proton error body at or under the ceiling SHALL still expose its numeric `Code` and string `Error`. A session-refresh success body at or under the ceiling that carries new tokens SHALL update the stored session. A session-refresh HTTP 4xx at or under the ceiling, other than 429, SHALL still clear the stored session. An oversized refresh body SHALL leave the stored session unchanged and SHALL NOT sign the user out.

#### Scenario: Metadata response within the ceiling
- **WHEN** a Proton JSON response, success or error, is 16 MiB or smaller
- **THEN** it is parsed as it is today, a Proton error still exposes its `Code` and `Error`, and throttling and transient retries are unchanged

#### Scenario: Metadata response over the ceiling
- **WHEN** a Proton JSON response exceeds 16 MiB, whether or not `Content-Length` advertised a smaller size
- **THEN** reading stops at the ceiling, the call fails, the error text and details contain none of the response bytes, no partial JSON is applied, and no local or remote user data is deleted or modified

#### Scenario: Oversized session refresh
- **WHEN** a session-refresh response body exceeds 16 MiB
- **THEN** the stored session is left unchanged, the user is not signed out, and no token from that body is saved

#### Scenario: Refresh within the ceiling
- **WHEN** a session-refresh success body within the ceiling contains new tokens
- **THEN** the stored session is updated with those tokens

#### Scenario: Rejected refresh within the ceiling
- **WHEN** session refresh returns an HTTP 4xx other than 429 whose body is within the ceiling
- **THEN** the stored session is cleared, as it is today

#### Scenario: File larger than the JSON ceiling
- **WHEN** a file-content download is larger than 16 MiB and the response is successful
- **THEN** the full content is delivered to the download path

#### Scenario: Oversized file-content error body
- **WHEN** a file-content request fails and its error body exceeds 16 MiB
- **THEN** the call fails with an error that contains none of those bytes, and nothing from that body is written as file content
