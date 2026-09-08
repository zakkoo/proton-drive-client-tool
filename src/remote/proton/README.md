# Proton account and API layer

This directory is a Node.js port of the MIT-licensed reference implementation
in the Proton Drive SDK repository:

- `incubating/account/js/src` (login via session fork, SRP, addresses/keys)
- `cli/src/api`, `cli/src/credentials`, `cli/src/cache`, `cli/src/init.ts`

Source: https://github.com/ProtonDriveApps/sdk (branch `main`, fetched 2026-09-07).
License: MIT, Copyright (c) Proton AG. See `LICENSE-proton.md`.

Differences from upstream, kept deliberately small so diffs stay readable:

- Bun-only APIs (`Bun.secrets`, `Bun.file`, `bun:sqlite`) replaced with the
  OS secret store adapter in `../../config/secretStore.ts`, `node:fs`, and `node:sqlite`.
- `ky` replaced with a small `fetch`-based client with an explicit retry,
  refresh and throttling policy (see `apiClient.ts`), because the sync engine
  needs those semantics to be testable and predictable.
- Telemetry and Sentry are not ported. No metrics are sent anywhere.
- Secrets are registered with the audit redaction registry the moment they
  are loaded so they can never appear in logs.
- The session is stored under our own service name, never shared with the
  official CLI's entry, so the two tools never race on token refresh.
