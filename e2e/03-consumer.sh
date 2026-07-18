#!/usr/bin/env bash
# E2E 03 — consumer: public catalogue → detail → pricing → try-it (optional paid call)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-zevium-e2e-consumer}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

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
# Ensure anonymous session (new browser session name already isolates cookies).
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
# Catalogue cards are plain Cards (no Link) in current app; detail route may be missing.
# Prefer click; require real navigation. Fall back to target-state URL.
clicked=0
before_url="$(ab get url)"
if [[ -n "$PROJECT_NAME" ]]; then
  name_js="$(printf '%s' "$PROJECT_NAME" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
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
  if [[ -n "$PROJECT_SLUG" ]]; then
    open_path "/catalogue/test-org/${PROJECT_SLUG}"
    ab wait 1200 >/dev/null
  else
    fail "no project name/slug to open detail; set E2E_LAST_PROJECT_* or run 02 first"
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
  fail "API detail route missing or listing not clickable (url=$url) — expected /catalogue/{org}/{api} with detail UI (pricing + try-it). App gap: cards are non-link Cards; no catalogue/\$org/\$slug route under apps/web/src/routes"
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
  if [[ -z "${E2E_API_KEY:-}" ]]; then
    fail "GATEWAY_URL set but E2E_API_KEY missing"
  fi
  # UI path: paste key if panel accepts it.
  if ab find placeholder "API key" fill "$E2E_API_KEY" >/dev/null 2>&1 \
    || ab find label "API key" fill "$E2E_API_KEY" >/dev/null 2>&1 \
    || ab fill 'input[name="apiKey"]' "$E2E_API_KEY" >/dev/null 2>&1; then
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
  org_slug="${E2E_ORG_SLUG:-test-org}"
  api_slug="${PROJECT_SLUG:-}"
  if [[ -z "$api_slug" ]]; then
    fail "PROJECT_SLUG empty for gateway call"
  fi
  call_url="${GATEWAY_URL%/}/gateway/${org_slug}/${api_slug}/get"
  log "curl $call_url"
  headers_file="$E2E_ARTIFACTS/gateway-headers-${STAMP:-$(e2e_stamp)}.txt"
  body_file="$E2E_ARTIFACTS/gateway-body-${STAMP:-$(e2e_stamp)}.txt"
  http_code="$(
    curl -sS -D "$headers_file" -o "$body_file" -w '%{http_code}' \
      -H "Authorization: Bearer ${E2E_API_KEY}" \
      -H "X-Api-Key: ${E2E_API_KEY}" \
      "$call_url" || true
  )"
  assert_eq "$http_code" "200" "gateway /get expected 200"
  hdrs="$(cat "$headers_file")"
  # header names are case-insensitive
  if ! printf '%s' "$hdrs" | grep -qi '^x-zevium-cost:'; then
    fail "missing x-zevium-cost response header (see $headers_file)"
  fi
  log "gateway call ok cost=$(printf '%s' "$hdrs" | grep -i '^x-zevium-cost:' | head -1)"

  step "anonymous browser mock call (CORS regression canary)"
  # /mock/:org/:project is PUBLIC (no key) — browser fetch from the app origin
  # to GATEWAY_URL is cross-origin, so this also proves CORS is wired.
  mock_url="${GATEWAY_URL%/}/mock/${org_slug}/${api_slug}/get"
  mock_status="$(ab eval "fetch('${mock_url}').then((r) => r.status)" 2>/dev/null || true)"
  mock_status="$(printf '%s' "$mock_status" | tr -d '"[:space:]')"
  assert_eq "$mock_status" "200" "anonymous browser mock call expected 200 (url=$mock_url)"
  log "anonymous browser mock call ok status=$mock_status"

  if [[ -n "${E2E_API_KEY:-}" ]]; then
    step "browser paid call with Authorization header"
    paid_status="$(ab eval "fetch('${call_url}', { headers: { Authorization: 'Bearer ${E2E_API_KEY}' } }).then((r) => r.status)" 2>/dev/null || true)"
    paid_status="$(printf '%s' "$paid_status" | tr -d '"[:space:]')"
    assert_eq "$paid_status" "200" "browser paid call expected 200 (url=$call_url)"
    log "browser paid call ok status=$paid_status"
  fi
else
  log "GATEWAY_URL unset — skip paid call (browse-only consumer path)"
fi

log "03-consumer PASS"
