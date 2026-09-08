#!/usr/bin/env bash
# Local CI gate: typecheck, lint, unit tests, fault-injection tests, build.
# Any failure blocks. Mirrors .github/workflows/ci.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm run lint
npm run test -- --project unit
npm run test -- --project fault --passWithNoTests
npm run build
echo "CI gate passed"
