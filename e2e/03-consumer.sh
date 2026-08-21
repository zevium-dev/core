#!/usr/bin/env bash
# E2E 03 — consumer: isolated anonymous browse/mock plus required staged paid contract hook
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-${E2E_SESSION_PREFIX:-zevium-e2e}-consumer-anonymous}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cleanup() {
  close_browser
  cleanup_e2e_runtime
}
trap cleanup EXIT

PROJECT_NAME="${E2E_LAST_PROJECT_NAME:-}"
PROJECT_SLUG="${E2E_LAST_PROJECT_SLUG:-}"
if [[ -z "$PROJECT_NAME" && -f "$E2E_FIXTURES_DIR/last-project-name.txt" ]]; then
  PROJECT_NAME="$(cat "$E2E_FIXTURES_DIR/last-project-name.txt")"
fi
if [[ -z "$PROJECT_SLUG" && -f "$E2E_FIXTURES_DIR/last-project-slug.txt" ]]; then
  PROJECT_SLUG="$(cat "$E2E_FIXTURES_DIR/last-project-slug.txt")"
fi
[[ -n "$PROJECT_NAME" ]] || fail "publisher fixture name missing — run 02 first"
[[ -n "$PROJECT_SLUG" ]] || fail "publisher fixture slug missing — run 02 first"
E2E_REQUIRE_PAID_CONTRACT="${E2E_REQUIRE_PAID_CONTRACT:-0}"
E2E_EXPECTED_CALL_COST="${E2E_EXPECTED_CALL_COST:-1}"
[[ "$E2E_EXPECTED_CALL_COST" =~ ^[1-9][0-9]*$ ]] || fail "E2E_EXPECTED_CALL_COST must be a positive integer"
configure_browser_context

step "wait for base url"
wait_for_url "$E2E_BASE_URL/" "200" 90
verify_target_commit "consumer"

step "anonymous /catalogue lists published project"
# Ensure anonymous session (new browser session name already isolates cookies).
open_path "/catalogue"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 1200 >/dev/null
assert_url_contains "/catalogue"
snap="$(page_text)"
assert_contains "$snap" "Catalogue" "catalogue heading missing"
assert_contains "$snap" "Public APIs with per-call credits" "catalogue blurb missing"
assert_anonymous_identity
record_browser_contract "consumer" "anonymous-catalogue" "anonymous"

assert_contains "$snap" "$PROJECT_NAME" "catalogue missing published project '$PROJECT_NAME'"
log "found project listing: $PROJECT_NAME"

step "open API detail page"
before_url="$(ab get url)"
ab find text "$PROJECT_NAME" click >/dev/null 2>&1 \
  || fail "catalogue card link missing or click failed"
ab wait 1200 >/dev/null
after_url="$(ab get url)"
DETAIL_PATH="${after_url#"$E2E_BASE_URL"}"
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
ab wait --fn "Array.from(document.querySelectorAll('[role=\"status\"]')).some((el) => /^\\s*200(?:\\s|$)/.test(el.textContent || ''))" --timeout 30000 >/dev/null 2>&1 \
  || fail "browser mock request did not return 200"
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

if [[ "$E2E_REQUIRE_PAID_CONTRACT" == "1" ]]; then
  verify_target_commit "paid-consumer"
  : "${E2E_API_KEY:?E2E_API_KEY is required for paid consumer contract}"
  step "signed-in paid consumer contract"
  use_browser_session "${E2E_SESSION_PREFIX:-zevium-e2e}-consumer-paid-signed-in"
  sign_in

  open_path "/app/billing"
  wait_for_text "Wallet balance" 30
  balance_before="$(ab eval "(() => { const label=Array.from(document.querySelectorAll('p')).find((el) => el.textContent?.trim()==='Wallet balance'); const value=label?.parentElement?.querySelector('.tabular-nums')?.textContent ?? ''; return Number(value.replace(/[^0-9-]/g,'')); })()" 2>/dev/null | tr -d '"[:space:]')"
  [[ "$balance_before" =~ ^[0-9]+$ ]] || fail "could not read pre-call wallet balance"
  (( balance_before >= E2E_EXPECTED_CALL_COST )) || fail "paid fixture wallet lacks required credits"

  open_path "$DETAIL_PATH"
  wait_for_text "Request playground" 30
  click_button "Live · ${E2E_EXPECTED_CALL_COST} credit" || click_button "Live · ${E2E_EXPECTED_CALL_COST} credits" || fail "paid live-mode toggle missing"
  ab fill '#api-key' "$E2E_API_KEY" >/dev/null || fail "paid fixture key field missing"
  click_button "Send live · ${E2E_EXPECTED_CALL_COST} credit" || click_button "Send live · ${E2E_EXPECTED_CALL_COST} credits" || fail "paid live submit missing"
  ab wait --fn "Array.from(document.querySelectorAll('[role=\"status\"]')).some((el) => /^\\s*200(?:\\s|$)/.test(el.textContent || ''))" --timeout 30000 >/dev/null 2>&1 \
    || fail "paid gateway call did not return 200"
  snap="$(page_text)"
  assert_not_contains "$snap" "mock response · 0 credits" "paid response was mislabeled as mock"
  assert_not_contains "$snap" "Your organization needs credits" "paid fixture was not funded"
  assert_not_contains "$snap" "Your API key was not accepted" "paid fixture key was rejected"

  step "paid debit reaches wallet projection"
  expected_balance=$((balance_before - E2E_EXPECTED_CALL_COST))
  balance_after=""
  for _ in $(seq 1 30); do
    open_path "/app/billing"
    balance_after="$(ab eval "(() => { const label=Array.from(document.querySelectorAll('p')).find((el) => el.textContent?.trim()==='Wallet balance'); const value=label?.parentElement?.querySelector('.tabular-nums')?.textContent ?? ''; return Number(value.replace(/[^0-9-]/g,'')); })()" 2>/dev/null | tr -d '"[:space:]')"
    [[ "$balance_after" == "$expected_balance" ]] && break
    ab wait 500 >/dev/null 2>&1 || true
  done
  assert_eq "$balance_after" "$expected_balance" "wallet projection did not debit exact published cost"

  step "paid call reaches attribution projection"
  attribution_seen=""
  for _ in $(seq 1 30); do
    open_path "/app/settings/activity"
    snap="$(page_text)"
    if [[ "$snap" == *"$PROJECT_NAME"* && "$snap" == *"/get"* ]]; then
      attribution_seen=1
      break
    fi
    ab wait 500 >/dev/null 2>&1 || true
  done
  [[ -n "$attribution_seen" ]] || fail "paid call never appeared in activity attribution"
  record_browser_contract "paid-consumer" "metered-call-attribution" "signed-in"
fi

log "03-consumer PASS paid_contract=$E2E_REQUIRE_PAID_CONTRACT"
