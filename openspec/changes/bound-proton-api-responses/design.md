## Context

See proposal.md for why this change exists. The behaviour contract is `specs/remote-drive-access/spec.md`.

`ProtonApiClient.request()` returns the raw `Response` after retry, throttle, and single-flight refresh. Two callers then buffer the body with no ceiling: `requestJson` uses `response.text()`, and `performRefresh` uses `response.json()` on a successful refresh. `SdkHttpClient.fetchJson` and `fetchBlob` return that same raw `Response`. The Drive SDK then calls `response.json()` on every metadata response and on file-content responses whose status is 400 or higher (`DriveAPIService.makeRequest` and `makeStorageRequest`). Successful file bytes are the response body stream, not a buffered JSON document. Metadata loads are already paged: `API_NODES_BATCH_SIZE` is 100.

`request()` is also used by callers that only check status, including refresh's non-OK branch, which signs out on a terminal 4xx before it reads a body.

## Goals / Non-Goals

**Goals:**

- One body-limiting wrapper, applied at every place a Proton JSON body is actually read, including the SDK's later `response.json()`.
- A production ceiling of 16 MiB that unit tests can lower without a config-file setting.
- Existing tests for refresh, throttling, and Proton `Code` stay valid without rewriting their assertions.

**Non-Goals:**

- Replacing Node's fetch stack or adding a custom undici dispatcher.
- Capping request bodies we send, or capping a successful file-content stream.
- A user setting, a different SDK page size, or edits under `node_modules/@protontech/drive-sdk`.
- Removing `systemctl` usage, renaming `setup.ts`, or deleting the `sudo` assertions. Those baseline hits are out of scope; see the proposal.

## Decisions

### Cap the body with a counting stream, not after `text()` or `json()`

Add a helper that wraps `response.body`. It pulls chunks with `getReader()`, adds each chunk's length, and once the next chunk would pass the ceiling it does not enqueue that chunk, cancels the reader, and errors the stream with `ResponseBodyTooLargeError`. The error's name and message are fixed. It carries no response bytes and no `details` payload.

If `Content-Length` is a finite number above the ceiling, cancel the body and fail before reading. That header is only an early exit. A missing header, or one that is smaller than the bytes that follow, still goes through the counter. The spec requires the counter.

Rebuild the `Response` with the same status and status text. Copy headers, then drop `content-encoding` and `content-length` so the new `Response` is not decoded a second time and does not advertise the old length. Keep the other headers, including `retry-after`.

`requestJson` reads `text()` from the wrapped response and parses as it does today. If the stream errors, that error propagates. It is not caught and reattached to a partial string. Bodies at or under the ceiling keep today's empty-body, JSON, and non-JSON fallback behaviour, and `ApiError` still carries `Code`, `Error`, and the parsed details.

**Alternative:** call `response.text()` and then reject if `text.length` is too big. That allocates the whole body first, which is the bug the review described. Rejected.

**Alternative:** trust `Content-Length` alone. Chunked responses omit it, and a header smaller than the real body would slip through. Rejected as the only check.

### Apply the wrapper at the readers, not inside `request()`

Wrap in four places:

- `requestJson`, for success and error bodies.
- `performRefresh`, only after `response.ok`, before reading JSON.
- `SdkHttpClient.fetchJson`, on every response, so the SDK's `response.json()` reads the capped stream.
- `SdkHttpClient.fetchBlob`, only when `status >= 400`. A successful blob response is returned unchanged.

`request()` stays raw. `fetchBlob` success and the status-only callers share it. Wrapping inside `request()` would put the JSON ceiling on file downloads.

On a non-OK refresh, keep the current order: log the status, sign out on a terminal 4xx other than 429, return false. Cancel that unread body so it is not retained. Do not parse it. An oversized success body fails the capped read, returns false, and calls neither `setSessionInfo` nor `signOut`.

**Alternative:** cap only `requestJson` and the refresh `response.json()`, the two line ranges in the review. The sync loop's Drive calls go through `fetchJson` and would stay unbounded. Rejected.

**Alternative:** cap every `fetchBlob` body at 16 MiB. A normal file larger than that would fail verification-sized downloads. Rejected.

### 16 MiB constant, overridable only in tests

`MAX_JSON_RESPONSE_BYTES` is `16 * 1024 * 1024`. `ApiClientOptions` gains an optional `maxJsonBodyBytes` used by tests. The default is the constant. Nothing in `config.json` or the CLI exposes it.

A metadata batch of 100 armored links is on the order of a megabyte. 16 MiB sits above that page and still stops a multi-gigabyte body. A real account that ever exceeds it fails that call and keeps its session and files. Raising the constant later does not change the wrapper.

**Alternative:** 1 MiB. Too close to a heavy metadata page. Rejected.

**Alternative:** a config knob. New surface for a ceiling users should not tune, and the spec forbids a user-facing setting. Rejected.

### Map the SDK's wrapped failure back to a size error

`DriveAPIService` catches a `response.json()` failure and `apiErrorFactory` builds an `APIHTTPError`. With no parsed result it prefers `response.statusText`, so a 200 whose body was cut can show up as message `"OK"` and status 200. `toRemoteError` would then report a non-retryable server error whose text is `"OK"`, or kind `unknown` if the stream error leaks through as a generic `ProtonDriveError`.

Recognize `ResponseBodyTooLargeError` on the thrown value or on `error.cause`. Map it to `RemoteError` kind `connection`, retryable, with a fixed message that the response exceeded the size limit. The engine's existing remote-failure path then marks the mirror unavailable and goes `offline`, which is how other connection failures are treated, and the status text is the size failure rather than `"OK"`. Do not clear the session.

**Alternative:** leave the SDK's `"OK"` text in place. The process would survive, but the user would see a successful-looking status for a rejected body. Rejected.

### Tests use a tiny ceiling

Extend `apiClient.test.ts` against the local HTTP server. Pass `maxJsonBodyBytes` of a few dozen bytes. Cover: a body of exactly that size parses; one extra byte fails and the error message does not contain a marker written past the ceiling; refresh over the ceiling does not change tokens or sign out; a small 4xx refresh still signs out; `fetchJson` then `response.json()` fails the same way; `fetchBlob` success larger than the ceiling returns every byte; `fetchBlob` status 422 with an oversized body fails with no marker. Keep the existing 422 `ApiError.code` test. Assert the default constant is 16 MiB without allocating a 16 MiB body.

Add one gzip JSON response under the ceiling through `fetchJson` so a rebuilt `Response` still parses after Node has already decompressed it.

Add a `toRemoteError` case if the mapper changes: a `ServerError` or `APIHTTPError` whose cause is `ResponseBodyTooLargeError` becomes a retryable connection error and the message does not contain a sample secret from the body.

## Risks / Trade-offs

- [16 MiB times concurrent in-flight JSON calls is still a large allocation] → Each call stops at the ceiling, and transfer concurrency is already bounded. The failure mode is a rejected call, not unbounded growth.
- [One platform chunk may already be allocated before the counter sees it] → That chunk is discarded and not copied into the accumulated body or the error. The rest of the body is not pulled. This change does not take over the socket reader.
- [A legitimate page above 16 MiB fails closed and the engine goes offline] → Same family of outcome as a connection failure. Session and files stay. The constant is the release valve if a real account hits it.
- [Rebuilding `Response` drops `content-length`] → Callers that need the file size use metadata or the download stream, not the JSON error path. The gzip test guards double-decode.
- [Editing issue #8128 retriggers validation, and a second body edit can discard a queued run] → One edit, after `master` HEAD is the fix commit, and no further body edit until that run finishes. See Migration Plan.

## Migration Plan

No state, config, or session migration. Ship the client change, then restart the user service so the running engine picks up the new runtime. Rollback is reverting the commit and restarting again. Sync folders, the Proton session, and `~/.config/proton-drive-sync` stay in place either way.

After that commit is on `master`, update the maintainer notes of omarchy-plugin-marketplace issue #8128 so they ask for validation of that full 40-character SHA. Edit the existing issue once. Do not open another `[Plugin]` issue.

## Open Questions

None. The ceiling, the file-download exception, and the decision to leave the baseline capability hits alone are fixed by the spec and the proposal.
