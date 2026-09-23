## ADDED Requirements

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
