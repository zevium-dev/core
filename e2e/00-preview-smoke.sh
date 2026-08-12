#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-${E2E_SESSION_PREFIX:-zevium-e2e}-preview-anonymous}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cleanup() {
  close_browser
  cleanup_e2e_runtime
}
trap cleanup EXIT

: "${GATEWAY_URL:?GATEWAY_URL is required}"
configure_browser_context

step "preview landing hydrates"
wait_for_url "$E2E_BASE_URL/" "200" 90
open_path "/"
snap="$(page_text)"
assert_contains "$snap" "One key. Every API. Pay per call." "landing failed to hydrate"
assert_contains "$snap" "Browse catalogue" "landing CTA missing"

step "preview catalogue loads"
open_path "/catalogue"
snap="$(page_text)"
assert_contains "$snap" "Catalogue" "catalogue heading missing"
assert_contains "$snap" "Public APIs with per-call credits" "catalogue copy missing"
assert_not_contains "$snap" "Something went wrong" "catalogue query failed"
assert_anonymous_identity
record_browser_contract "preview" "preview-catalogue" "anonymous"

step "preview gateway health"
health="$(curl -fsS "${GATEWAY_URL%/}/health")"
assert_contains "$health" '"ok":true' "gateway health failed"
assert_contains "$health" '"service":"zevium-gateway"' "wrong gateway service"

log "00-preview-smoke PASS"
