#!/usr/bin/env bash
# E2E 03 — consumer: public catalogue → detail → pricing → try-it (optional paid call)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-zevium-e2e-consumer}"
# shellcheck source=e2e/lib.sh
source "$SCRIPT_DIR/lib.sh"
E2E_RELEASE_KEY="${E2E_API_KEY:-}"
unset E2E_API_KEY

cleanup() {
  close_browser
}
trap cleanup EXIT

PROJECT_NAME="${E2E_LAST_PROJECT_NAME:-}"
PROJECT_SLUG="${E2E_LAST_PROJECT_SLUG:-}"
if [[ -z "$PROJECT_NAME" && -f "$E2E_ARTIFACTS/last-project-name.txt" ]]; then
  PROJECT_NAME="$(cat "$E2E_ARTIFACTS/last-project-name.txt")"
fi
if [[ -z "$PROJECT_SLUG" && -f "$E2E_ARTIFACTS/last-project-slug.txt" ]]; then
  PROJECT_SLUG="$(cat "$E2E_ARTIFACTS/last-project-slug.txt")"
fi

step "wait for base url"
wait_for_url "$E2E_BASE_URL/" "200" 90

step "anonymous /catalogue lists published project"
# run-all assigns this script its own browser session, isolating auth cookies.
open_path "/catalogue"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 1200 >/dev/null
assert_url_contains "/catalogue"
snap="$(page_text)"
assert_contains "$snap" "Catalogue" "catalogue heading missing"
assert_contains "$snap" "Public APIs with per-call credits" "catalogue blurb missing"

if [[ -n "$PROJECT_NAME" ]]; then
  if [[ "$snap" != *"$PROJECT_NAME"* && ( -z "$PROJECT_SLUG" || "$snap" != *"$PROJECT_SLUG"* ) ]]; then
    fail "catalogue missing published project '$PROJECT_NAME' (run 02 first or app catalogue not wired)"
  fi
  log "found project listing: $PROJECT_NAME"
else
  log "no E2E_LAST_PROJECT_NAME — asserting catalogue shell only (no specific listing)"
fi

step "open API detail page"
clicked=0
detail_path=""
before_url="$(ab get url)"
if [[ -n "$PROJECT_NAME" ]]; then
  name_js="$(printf '%s' "$PROJECT_NAME" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  slug_js="$(printf '%s' "$PROJECT_SLUG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  detail_path="$(ab eval "(() => { const link=Array.from(document.querySelectorAll('a[href]')).find((node) => { const text=(node.textContent || '').trim(); const href=node.getAttribute('href') || ''; return text.includes(${name_js}) && href.endsWith('/' + ${slug_js}); }); return link?.getAttribute('href') || ''; })()" 2>/dev/null | tail -1 | tr -d '"\r')"
  [[ "$detail_path" == /catalogue/*/"$PROJECT_SLUG" ]] \
    || fail "catalogue listing has no canonical detail link for '$PROJECT_NAME'"
  discovered_org_slug="${detail_path#/catalogue/}"
  discovered_org_slug="${discovered_org_slug%%/*}"
  [[ "$discovered_org_slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
    || fail "catalogue detail link has invalid publisher handle"
  ab eval "
(() => {
  const want = ${name_js};
  const nodes = Array.from(document.querySelectorAll('h3, a, button, div, span'));
  const el = nodes.find((n) => (n.textContent || '').trim() === want)
    || nodes.find((n) => (n.textContent || '').includes(want));
  if (!el) return 'missing';
  el.scrollIntoView({ block: 'center' });
  return 'ok';
})()
" >/dev/null 2>&1 || true
  if ab find text "$PROJECT_NAME" click >/dev/null 2>&1; then
    ab wait 1200 >/dev/null
    after_url="$(ab get url)"
    if [[ "$after_url" != "$before_url" ]]; then
      clicked=1
    else
      log "card click did not navigate (cards may not be links)"
    fi
  fi
fi

if (( clicked == 0 )); then
  if [[ -n "$detail_path" ]]; then
    open_path "$detail_path"
    ab wait 1200 >/dev/null
  else
    fail "no project detail target; set E2E_LAST_PROJECT_* or run 02 first"
  fi
fi

url="$(ab get url)"
snap="$(page_text)"
# Detail route missing → still on list, 404, or Not Found shell.
if [[ "$url" == *"/sign-in"* ]]; then
  fail "catalogue detail unexpectedly requires auth"
fi
if [[ "$snap" == *"Not Found"* || "$snap" == *"404"* \
  || ( "$url" == *"/catalogue" && "$url" != *"$PROJECT_SLUG"* ) \
  || ( "$url" == *"/catalogue" && "$snap" == *"Public APIs with per-call credits"* && "$snap" == *"Search catalogue"* ) ]]; then
  fail "API detail route missing or listing did not navigate (url=$url)"
fi

step "pricing table shows credits"
snap="$(page_text)"
# Must be detail content, not the catalogue blurb alone.
if [[ "$snap" != *"credit"* && "$snap" != *"Credit"* && "$snap" != *"x-zevium-cost"* && "$snap" != *"pricing"* && "$snap" != *"Pricing"* ]]; then
  fail "pricing/credits not visible on detail page (missing product UI)"
fi
# Reject false positive if we somehow only have catalogue shell blurb.
if [[ "$snap" == *"Public APIs with per-call credits"* && "$snap" != *"x-zevium-cost"* && "$snap" != *"Pricing"* && "$snap" != *"pricing"* ]]; then
  # blurb alone is not enough — need operation-level pricing signal
  if [[ "$snap" != *"/get"* && "$snap" != *"operation"* && "$snap" != *"Operation"* && "$snap" != *"cost"* ]]; then
    fail "pricing/credits signal is only catalogue blurb — no detail pricing table (app gap)"
  fi
fi
log "pricing/credits signal present"

step "try-it panel renders"
snap="$(page_text)"
if [[ "$snap" != *"Try it"* && "$snap" != *"Try It"* && "$snap" != *"playground"* && "$snap" != *"Playground"* && "$snap" != *"Run"* ]]; then
  fail "try-it / playground panel not found on detail page (app gap)"
fi
log "try-it panel signal present"

# Optional paid gateway call — only when GATEWAY_URL + E2E_API_KEY provided.
if [[ -n "${GATEWAY_URL:-}" ]]; then
  step "paid try-it call via GATEWAY_URL"
  if [[ -z "$E2E_RELEASE_KEY" ]]; then
    fail "GATEWAY_URL set but E2E_API_KEY missing"
  fi
  # UI path: paste key if panel accepts it.
  if ab_fill_secret placeholder "API key" 2>/dev/null \
    || ab_fill_secret label "API key" 2>/dev/null \
    || ab_fill_secret css 'input[name="apiKey"]' 2>/dev/null; then
    if click_button "Run" \
      || click_button "Send" \
      || ab find text "Run request" click >/dev/null 2>&1; then
      ab wait 2000 >/dev/null
      snap="$(page_text)"
      assert_contains "$snap" "200" "try-it response status not 200"
    else
      log "UI run button missing — falling back to curl against gateway"
    fi
  fi

  # Deterministic gate: direct gateway call for /get
  # Convention: GATEWAY_URL is origin; path /gateway/{org}/{api}/get
  org_slug="${E2E_ORG_SLUG:-${discovered_org_slug:-}}"
  api_slug="${PROJECT_SLUG:-}"
  if [[ -z "$api_slug" ]]; then
    fail "PROJECT_SLUG empty for gateway call"
  fi
  [[ "$org_slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
    || fail "E2E_ORG_SLUG is not a canonical slug"
  [[ -z "${discovered_org_slug:-}" || "$org_slug" == "$discovered_org_slug" ]] \
    || fail "E2E_ORG_SLUG does not own published catalogue project"
  [[ "$api_slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
    || fail "PROJECT_SLUG is not a canonical slug"
  call_url="${GATEWAY_URL%/}/gateway/${org_slug}/${api_slug}/get"
  release_challenge="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  [[ "$release_challenge" =~ ^[0-9a-f]{64}$ ]] \
    || fail "release challenge generation failed"
  log "curl $call_url"
  headers_file="$E2E_ARTIFACTS/gateway-headers-${STAMP:-$(e2e_stamp)}.txt"
  body_file="$E2E_ARTIFACTS/gateway-body-${STAMP:-$(e2e_stamp)}.txt"
  http_code="$(
    {
      printf 'header = "Authorization: Bearer %s"\n' "$E2E_RELEASE_KEY"
      printf 'header = "X-Api-Key: %s"\n' "$E2E_RELEASE_KEY"
      printf 'header = "X-Zevium-Release-Challenge: %s"\n' "$release_challenge"
    } | curl -sS --connect-timeout 2 --max-time 15 --config - \
      -D "$headers_file" -o "$body_file" -w '%{http_code}' \
      "$call_url" || true
  )"
  assert_eq "$http_code" "200" "gateway /get expected 200"
  hdrs="$(cat "$headers_file")"
  # header names are case-insensitive
  if ! printf '%s' "$hdrs" | grep -qi '^x-zevium-cost:'; then
    fail "missing x-zevium-cost response header (see $headers_file)"
  fi
  cost="$(printf '%s' "$hdrs" | awk -F ': *' 'tolower($1)=="x-zevium-cost" {gsub(/\r/, "", $2); print $2; exit}')"
  [[ "$cost" =~ ^[1-9][0-9]*$ ]] \
    || fail "metered gateway cost must be positive integer (got '$cost')"
  request_id="$(printf '%s' "$hdrs" | awk -F ': *' 'tolower($1)=="x-zevium-request-id" {gsub(/\r/, "", $2); print $2; exit}')"
  [[ -n "$request_id" ]] || fail "metered gateway request id missing"
  log "gateway call ok cost=$cost request-id-present=true"

  step "anonymous browser mock call (CORS regression canary)"
  # /mock/:org/:project is PUBLIC (no key) — browser fetch from the app origin
  # to GATEWAY_URL is cross-origin, so this also proves CORS is wired.
  mock_url="${GATEWAY_URL%/}/mock/${org_slug}/${api_slug}/get"
  mock_url_js="$(printf '%s' "$mock_url" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  mock_status="$(ab eval "fetch(${mock_url_js}).then((r) => r.status)" 2>/dev/null || true)"
  mock_status="$(printf '%s' "$mock_status" | tr -d '"[:space:]')"
  assert_eq "$mock_status" "200" "anonymous browser mock call expected 200 (url=$mock_url)"
  log "anonymous browser mock call ok status=$mock_status"

  if [[ -n "$E2E_RELEASE_KEY" ]]; then
    step "browser paid call with Authorization header"
    paid_status="$(ab_paid_fetch "$call_url" 2>/dev/null || true)"
    paid_status="$(printf '%s' "$paid_status" | tr -d '"[:space:]')"
    assert_eq "$paid_status" "200" "browser paid call expected 200 (url=$call_url)"
    log "browser paid call ok status=$paid_status"
  fi

  step "metered call lands in authenticated activity log"
  sign_in
  activity_found=false
  project_js="$(printf '%s' "$PROJECT_NAME" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  cost_js="$(printf '%s' "$cost" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  request_id_js="$(printf '%s' "$request_id" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  release_challenge_js="$(printf '%s' "$release_challenge" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  for _ in $(seq 1 30); do
    open_path "/app/settings/activity?range=24h"
    row_found="$(ab eval "Array.from(document.querySelectorAll('tbody tr')).some((row) => { const cells=Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent || '').replace(/\\s+/g, ' ').trim()); return row.dataset.requestId === ${request_id_js} && row.dataset.releaseChallenge === ${release_challenge_js} && cells.length >= 5 && cells[1].includes(${project_js}) && cells[2] === 'GET /get' && cells[3] === Number(${cost_js}).toLocaleString() && cells[4] === '200'; })" 2>/dev/null | tail -1)"
    if [[ "$row_found" == "true" ]]; then
      activity_found=true
      break
    fi
    ab wait 2000 >/dev/null 2>&1 || sleep 2
  done
  [[ "$activity_found" == "true" ]] \
    || fail "exact paid request/challenge never appeared in activity log for '$PROJECT_NAME'"
  log "metered usage event visible in activity log"
else
  log "GATEWAY_URL unset — skip paid call (browse-only consumer path)"
fi

log "03-consumer PASS"
