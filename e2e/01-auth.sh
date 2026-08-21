#!/usr/bin/env bash
# E2E 01 — auth + protected routes
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-${E2E_SESSION_PREFIX:-zevium-e2e}-auth-anonymous}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cleanup() {
  close_browser
  cleanup_e2e_runtime
}
trap cleanup EXIT
configure_browser_context

step "wait for base url"
wait_for_url "$E2E_BASE_URL/" "200" 90
verify_target_commit "auth"

step "anonymous landing /"
open_path "/"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 800 >/dev/null
code="$(curl -s -o /dev/null -w '%{http_code}' "$E2E_BASE_URL/")"
assert_eq "$code" "200" "GET / should be 200"
snap="$(page_text)"
assert_contains "$snap" "One key. Every API. Pay per call." "landing hero missing"
assert_contains "$snap" "Browse catalogue" "landing CTA missing"

step "anonymous /app redirects to sign-in"
open_path "/app"
ab wait 1500 >/dev/null
url="$(ab get url)"
assert_contains "$url" "sign-in" "/app must bounce anonymous users to sign-in (url=$url)"
assert_anonymous_identity
record_browser_contract "auth" "protected-route-anonymous" "anonymous"

step "sign_in with seed credentials"
use_browser_session "${E2E_SESSION_PREFIX:-zevium-e2e}-auth-signed-in"
sign_in

step "signed-in /app/projects loads"
open_path "/app/projects"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 1200 >/dev/null
assert_url_contains "/app/projects" "expected projects route after auth"
snap="$(page_text)"
assert_not_contains "$snap" "Something went wrong" "projects page error banner"
assert_not_contains "$snap" "No active organization" "seed organization must be active"
assert_contains "$snap" "Projects" "projects heading missing"
assert_contains "$snap" "New project" "admin project action missing"
ensure_org_active
record_browser_contract "auth" "projects-signed-in" "signed-in"

log "01-auth PASS"
