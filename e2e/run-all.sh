#!/usr/bin/env bash
# Run real journeys sequentially; publisher fixtures feed the consumer journey.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:3000}"
export E2E_RUN_ID="${E2E_RUN_ID:-$(date +%Y%m%dT%H%M%S)-$$}"
export E2E_SESSION_PREFIX="${E2E_SESSION_PREFIX:-zevium-e2e-$E2E_RUN_ID}"
# Each journey selects its own lane suffix, including on retries.
unset E2E_SESSION AGENT_BROWSER_SESSION
export E2E_RUNTIME_DIR
E2E_RUNTIME_DIR="$(mktemp -d /tmp/zevium-e2e-runtime.XXXXXX)"
export E2E_FIXTURES_DIR="$E2E_RUNTIME_DIR/fixtures"
export E2E_OWNS_RUNTIME=0
mkdir -m 700 "$E2E_FIXTURES_DIR"
trap 'rm -rf -- "$E2E_RUNTIME_DIR"' EXIT

export E2E_REQUIRE_PAID_CONTRACT=0
if [[ -n "${E2E_API_KEY:-}" ]]; then
  export E2E_REQUIRE_PAID_CONTRACT=1
fi

scripts=()
if [[ "${E2E_RUN_PREVIEW:-0}" == "1" || -n "${GATEWAY_URL:-}" ]]; then
  scripts+=(00-preview-smoke.sh)
fi
scripts+=(01-auth.sh 02-publisher.sh 03-consumer.sh)

for script in "${scripts[@]}"; do
  printf '=== %s ===\n' "$script"
  bash "$ROOT/$script"
done
printf 'E2E journeys passed (paid consumer: %s)\n' "$E2E_REQUIRE_PAID_CONTRACT"
