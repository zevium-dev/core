#!/usr/bin/env bash
# Run all Zevium browser E2E scripts in order. Exit nonzero on first failure.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:3000}"
export E2E_ARTIFACTS="${E2E_ARTIFACTS:-$ROOT/artifacts}"
mkdir -p "$E2E_ARTIFACTS"

# Auth and publisher share one session. Consumer gets a clean session so its
# public-catalogue assertions cannot pass on leaked auth state.
SUITE_SESSION="${E2E_SESSION:-zevium-e2e}"
E2E_RELEASE_KEY="${E2E_API_KEY:-}"
unset E2E_API_KEY

SCRIPTS=(
  "01-auth.sh"
  "02-publisher.sh"
  "03-consumer.sh"
)

declare -a RESULTS=()
FAILED=0
START_ALL="$(date +%s)"

printf '=== Zevium E2E ===\n'
printf 'base: %s\n' "$E2E_BASE_URL"
printf 'artifacts: %s\n' "$E2E_ARTIFACTS"
printf '\n'

for script in "${SCRIPTS[@]}"; do
  path="$ROOT/$script"
  if [[ ! -x "$path" && -f "$path" ]]; then
    chmod +x "$path"
  fi
  printf '── %s ──\n' "$script"
  t0="$(date +%s)"
  set +e
  # Project identity propagates through artifact files. Browser auth must not.
  if [[ "$script" == "03-consumer.sh" ]]; then
    E2E_API_KEY="$E2E_RELEASE_KEY" E2E_SESSION="${SUITE_SESSION}-consumer" bash "$path"
  else
    E2E_SESSION="$SUITE_SESSION" bash "$path"
  fi
  code=$?
  set -e
  t1="$(date +%s)"
  dur=$((t1 - t0))
  if (( code == 0 )); then
    RESULTS+=("PASS  $script  (${dur}s)")
    printf 'OK %s (%ss)\n\n' "$script" "$dur"
  else
    RESULTS+=("FAIL  $script  (${dur}s) exit=$code")
    printf 'FAIL %s exit=%s (%ss)\n\n' "$script" "$code" "$dur"
    FAILED=1
    break
  fi
done

END_ALL="$(date +%s)"
TOTAL=$((END_ALL - START_ALL))

printf '=== summary (%ss) ===\n' "$TOTAL"
for line in "${RESULTS[@]}"; do
  printf '  %s\n' "$line"
done
if (( FAILED )); then
  printf '  (remaining scripts skipped after first failure)\n'
  exit 1
fi
printf 'ALL PASS\n'
exit 0
