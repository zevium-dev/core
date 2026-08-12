#!/usr/bin/env bash
# Runs requested Zevium browser lanes with isolated contexts and honest coverage labels.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:3000}"
export E2E_RUN_ID="${E2E_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
export E2E_SESSION_PREFIX="${E2E_SESSION_PREFIX:-zevium-e2e-$E2E_RUN_ID}"
export E2E_RUNTIME_DIR="${E2E_RUNTIME_DIR:-$(mktemp -d /tmp/zevium-e2e-runtime.XXXXXX)}"
export E2E_OWNS_RUNTIME=1
export E2E_RAW_DIR="$E2E_RUNTIME_DIR/raw"
export E2E_FIXTURES_DIR="$E2E_RUNTIME_DIR/fixtures"
export E2E_MANIFEST_STATE="$E2E_RUNTIME_DIR/manifest-state.json"
export E2E_ARTIFACTS="${E2E_ARTIFACTS:-$ROOT/artifacts/$E2E_RUN_ID}"
export E2E_EXPECTED_COMMIT="${E2E_EXPECTED_COMMIT:-}"

# shellcheck source=lib.sh
source "$ROOT/lib.sh"
export E2E_OWNS_RUNTIME=0
export E2E_RUNNER_ACTIVE=1

runner_cleanup() {
  close_browser
  E2E_OWNS_RUNTIME=1 cleanup_e2e_runtime
}
trap runner_cleanup EXIT

RUN_PREVIEW="${E2E_RUN_PREVIEW:-0}"
RUN_PAYMENT="${E2E_RUN_PAYMENT:-0}"
if [[ -n "${GATEWAY_URL:-}" ]]; then RUN_PREVIEW=1; fi
if [[ -n "${E2E_API_KEY:-}" ]]; then
  export E2E_REQUIRE_PAID_CONTRACT=1
else
  export E2E_REQUIRE_PAID_CONTRACT=0
fi

declare -a SCRIPTS=()
declare -A SCRIPT_LANE=()
declare -A STATUS=()
declare -A DURATION=()
declare -A PROOF=()

for lane in preview auth publisher consumer paid-consumer payment; do
  STATUS["$lane"]="excluded"
  DURATION["$lane"]=0
  PROOF["$lane"]="lane not requested or required credentials absent"
done

if [[ "$RUN_PREVIEW" == "1" ]]; then
  SCRIPTS+=("00-preview-smoke.sh")
  SCRIPT_LANE["00-preview-smoke.sh"]="preview"
  STATUS[preview]="skipped"
  PROOF[preview]="requested; waiting to run"
fi

SCRIPTS+=("01-auth.sh" "02-publisher.sh" "03-consumer.sh")
SCRIPT_LANE["01-auth.sh"]="auth"
SCRIPT_LANE["02-publisher.sh"]="publisher"
SCRIPT_LANE["03-consumer.sh"]="consumer"
for lane in auth publisher consumer; do
  STATUS["$lane"]="skipped"
  PROOF["$lane"]="requested; waiting to run"
done
if [[ "$E2E_REQUIRE_PAID_CONTRACT" == "1" ]]; then
  STATUS[paid-consumer]="skipped"
  PROOF[paid-consumer]="provider-backed paid contract requested"
else
  PROOF[paid-consumer]="E2E_API_KEY absent; provider-backed debit contract excluded"
fi

if [[ "$RUN_PAYMENT" == "1" ]]; then
  SCRIPTS+=("04-payment-drill.sh")
  SCRIPT_LANE["04-payment-drill.sh"]="payment"
  STATUS[payment]="skipped"
  PROOF[payment]="provider payment/refund lane requested"
else
  PROOF[payment]="E2E_RUN_PAYMENT is not 1; provider payment/refund lane excluded"
fi

FAILED=0
START_ALL="$(date +%s)"

printf '=== Zevium E2E requested lanes ===\n'
printf 'base: %s\n' "$E2E_BASE_URL"
printf 'artifacts: %s\n' "$E2E_ARTIFACTS"
printf 'run id: %s\n\n' "$E2E_RUN_ID"

for script in "${SCRIPTS[@]}"; do
  lane="${SCRIPT_LANE[$script]}"
  printf '── %s [%s] ──\n' "$script" "$lane"
  t0="$(date +%s)"
  set +e
  bash "$ROOT/$script"
  code=$?
  set -e
  t1="$(date +%s)"
  duration=$((t1 - t0))
  DURATION["$lane"]="$duration"
  if (( code == 0 )); then
    STATUS["$lane"]="passed"
    PROOF["$lane"]="$script completed its asserted browser contract"
    if [[ "$script" == "03-consumer.sh" && "$E2E_REQUIRE_PAID_CONTRACT" == "1" ]]; then
      STATUS[paid-consumer]="passed"
      DURATION[paid-consumer]="$duration"
      PROOF[paid-consumer]="live gateway 200, exact wallet debit, and activity attribution asserted"
    fi
    printf 'PASS %s (%ss)\n\n' "$script" "$duration"
  else
    STATUS["$lane"]="failed"
    PROOF["$lane"]="$script exited $code"
    if [[ "$script" == "03-consumer.sh" && "$E2E_REQUIRE_PAID_CONTRACT" == "1" ]]; then
      STATUS[paid-consumer]="failed"
      DURATION[paid-consumer]="$duration"
      PROOF[paid-consumer]="consumer script failed before paid contract completed"
    fi
    printf 'FAIL %s exit=%s (%ss)\n\n' "$script" "$code" "$duration"
    FAILED=1
    break
  fi
done

for lane in preview auth publisher consumer paid-consumer payment; do
  record_manifest_result "$lane" "${STATUS[$lane]}" "${DURATION[$lane]}" "${PROOF[$lane]}"
done

TOTAL=$(($(date +%s) - START_ALL))
printf '=== exact coverage summary (%ss) ===\n' "$TOTAL"
for lane in preview auth publisher consumer paid-consumer payment; do
  printf '  %-14s %-8s %s\n' "$lane" "${STATUS[$lane]}" "${PROOF[$lane]}"
done

manifest="$E2E_ARTIFACTS/evidence-manifest.json"
build_evidence_manifest "$manifest"
printf 'manifest: %s\n' "$manifest"

if (( FAILED )); then exit 1; fi
exit 0
