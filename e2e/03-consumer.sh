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
[[ -n "$PROJECT_NAME" ]] || fail "publisher fixture name missing — run 02 first"
[[ -n "$PROJECT_SLUG" ]] || fail "publisher fixture slug missing — run 02 first"

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

assert_contains "$snap" "$PROJECT_NAME" "catalogue missing published project '$PROJECT_NAME'"
log "found project listing: $PROJECT_NAME"

step "open API detail page"
before_url="$(ab get url)"
ab find text "$PROJECT_NAME" click >/dev/null 2>&1 \
  || fail "catalogue card link missing or click failed"
ab wait 1200 >/dev/null
after_url="$(ab get url)"
[[ "$after_url" != "$before_url" ]] || fail "catalogue card click did not navigate"
assert_url_contains "/${PROJECT_SLUG}" "catalogue card navigated to wrong API"

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

step "try-it panel renders and sends real browser mock"
snap="$(page_text)"
assert_contains "$snap" "Request playground" "request playground missing"
assert_contains "$snap" "Mock · 0 credits" "safe mock mode is not default"
click_button "Send mock · 0 credits" || fail "mock submit button missing"
ab wait --text "200 OK" 20 || fail "browser mock request did not return 200"
snap="$(page_text)"
assert_contains "$snap" "mock response · 0 credits" "mock result badge missing"
assert_not_contains "$snap" "Gateway could not be reached" "browser could not reach gateway"

step "live mode fails closed without API key"
click_button "Live · 1 credit" || fail "live-mode toggle missing"
ab wait 300 >/dev/null
click_button "Send live · 1 credit" || fail "live submit button missing"
ab wait 300 >/dev/null
snap="$(page_text)"
assert_contains "$snap" "API key is required for a live call." "live mode did not reject missing key"
focused="$(ab eval "document.activeElement?.id" 2>/dev/null | tr -d '"[:space:]')"
assert_eq "$focused" "api-key" "missing-key validation did not focus API key"

log "03-consumer PASS"
