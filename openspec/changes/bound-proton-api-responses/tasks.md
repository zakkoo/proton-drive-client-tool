## 1. Cap JSON bodies in the Proton client

- [x] 1.1 Add `ResponseBodyTooLargeError`, `MAX_JSON_RESPONSE_BYTES` (16 × 1024 × 1024), and optional `ApiClientOptions.maxJsonBodyBytes`. Wrap response bodies with a counting reader that cancels without enqueueing the chunk that would pass the ceiling, rejects immediately when `Content-Length` is above the ceiling, and rebuilds the `Response` without `content-encoding` or `content-length`. Use that wrapper in `requestJson` and on a successful refresh before JSON is parsed. On a non-OK refresh, keep today's sign-out for a terminal 4xx other than 429 and cancel the unread body. Verify `npx vitest run --project unit src/remote/proton/apiClient.test.ts`: a body of exactly the test ceiling parses, one byte over fails and the error does not contain a marker past the ceiling, an oversized refresh leaves tokens and login state unchanged, a small 4xx refresh still signs out, and the existing 422 `ApiError.code` assertion still passes.

- [x] 1.2 Wrap every `SdkHttpClient.fetchJson` response, and wrap `fetchBlob` only when status is 400 or higher. Verify in the same api-client test file: `fetchJson` then `response.json()` fails over the ceiling with no marker in the error, a successful `fetchBlob` larger than the ceiling returns every byte, a `fetchBlob` 422 with an oversized body fails with no marker, and a gzip JSON body under the ceiling still parses through `fetchJson`.

## 2. Report the size failure

- [x] 2.1 In `toRemoteError`, recognize `ResponseBodyTooLargeError` on the error or on `error.cause` and map it to a retryable `connection` `RemoteError` whose message says the response exceeded the size limit and includes no response bytes. Do not clear the session. Verify a `toRemoteError` case in `src/remote/sdkRemoteDrive.test.ts` for both the direct error and an SDK HTTP error that only has it as `cause`.

## 3. Check

- [x] 3.1 Run `npx vitest run --project unit src/remote/proton/apiClient.test.ts src/remote/sdkRemoteDrive.test.ts` and `npx tsc -p tsconfig.json --noEmit`. Confirm both pass, and confirm `scripts/install-engine`, the README `systemctl` lines, and the `sudo` assertions in `src/cli/engineInstall.test.ts` are unchanged.

## 4. Ask for the corrected commit to be reviewed

- [ ] 4.1 Leave this unchecked until the fix commit is the default-branch HEAD of `zakkoo/proton-drive-sync`. Then edit the maintainer notes of [omarchy-plugin-marketplace#8128](https://github.com/omacom/omarchy-plugin-marketplace/issues/8128) once so they ask for validation of that full 40-character SHA. Do not open a second submission issue, and do not edit the body again while that validation run is queued. Verify the issue body contains that SHA.
