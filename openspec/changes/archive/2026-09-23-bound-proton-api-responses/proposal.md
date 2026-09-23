## Why

Marketplace review of [omarchy-plugin-marketplace#8128](https://github.com/omacom/omarchy-plugin-marketplace/issues/8128) at commit `4f025bc2ac1b9339facf4323be83dff2ff02e580` found that the long-running sync engine buffers Proton JSON bodies with no size ceiling. `requestJson` reads every body with `response.text()`, and session refresh reads a success body with `response.json()`. A hostile or compromised API can force an arbitrarily large allocation and kill the process. The listing cannot move forward until that path is capped and the corrected commit is the one validation reviews.

## What Changes

- Cap Proton JSON response bodies, including success, error, and session-refresh bodies, while the bytes are still being read. Stop reading once the ceiling is passed, and fail with an error that does not contain the response body.
- Apply the same ceiling to JSON responses handed to the Drive SDK, and to storage-error bodies. Leave successful file-content downloads uncapped so a normal file larger than the JSON ceiling still syncs.
- Keep today's behaviour for every body at or under the ceiling: parsed JSON, Proton error `Code` / `Error`, retry and throttle policy, and refresh sign-out on a parsed terminal 4xx.
- Do not treat an oversized refresh body as a revoked session, and do not install tokens from a partial body.
- After the fix is on `master`, ask the existing submission issue to revalidate that full 40-character SHA. Do not open a second submission.

The automated baseline's `service-management`, `installer`, and `privilege` hits stay as they are. They describe the documented user-service installer, or `sudo` only inside tests that assert its absence. Removing them would break install or the safety tests, and the baseline comment says no change is required for those capabilities.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote-drive-access`: Proton metadata, error, and refresh bodies gain a hard byte ceiling and a bounded failure. File-content downloads stay streamed without that ceiling.

## Impact

- `src/remote/proton/apiClient.ts` and `src/remote/proton/apiClient.test.ts`. The Drive SDK package is not modified; `SdkHttpClient.fetchJson` and failed `fetchBlob` responses are wrapped before the SDK reads them.
- `src/remote/sdkRemoteDrive.ts` only if the SDK's wrapper hides the bounded error behind a generic "OK" status, so the engine reports the size failure instead of a misleading server message. No change to login, sync roots, trash, or local files.
- Default ceiling is 16 MiB, above a Drive metadata page (the SDK loads node metadata in batches of 100). It is not a user setting.
- Follow-up on issue #8128 only: one edit of the existing issue body so validation, the baseline, and reviewed HEAD share the new commit. `security-review-required` remains expected.
