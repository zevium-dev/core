#!/usr/bin/env bash
# E2E 02 — publisher golden path: create → spec → publish → public → catalogue
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-zevium-e2e-publisher}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cleanup() {
  close_browser
}
trap cleanup EXIT

STAMP="$(e2e_stamp)"
PROJECT_NAME="E2E Weather ${STAMP}"
# slugify-compatible: lowercase, hyphens
PROJECT_SLUG="e2e-weather-${STAMP}"
SPEC_FILE="$E2E_ARTIFACTS/openapi-${STAMP}.json"
# Persist name for 03-consumer if run in same shell/suite
export E2E_LAST_PROJECT_NAME="$PROJECT_NAME"
export E2E_LAST_PROJECT_SLUG="$PROJECT_SLUG"
printf '%s\n' "$PROJECT_NAME" >"$E2E_ARTIFACTS/last-project-name.txt"
printf '%s\n' "$PROJECT_SLUG" >"$E2E_ARTIFACTS/last-project-slug.txt"

step "wait for base url"
wait_for_url "$E2E_BASE_URL/" "200" 90

step "sign_in"
sign_in

step "open /app/projects"
open_path "/app/projects"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 1200 >/dev/null
assert_url_contains "/app/projects"
snap="$(page_text)"
assert_not_contains "$snap" "Something went wrong" "projects list SSR/auth error"
if [[ "$snap" == *"No active organization"* ]]; then
  fail "no active organization — seed org test-org missing or not selected"
fi

step "create project $PROJECT_NAME"
open_path "/app/projects/create"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 800 >/dev/null
snap="$(page_text)"
assert_url_contains "/app/projects/create" "New project navigation failed"
assert_contains "$snap" "New project" "New project form missing on first request"
assert_not_contains "$snap" "Something went wrong" "New project failed on first request"
assert_not_contains "$snap" "HTTPError" "raw create-page error leaked"

ab fill '#project-name' "$PROJECT_NAME" >/dev/null

click_button "Create project" 'button[type="submit"]' \
  || fail "Create project button missing or click failed"

# Navigate to project detail (poll URL — agent-browser --url globs are flaky)
wait_for_url_pattern "/app/projects/${PROJECT_SLUG}" 40
ab wait 1000 >/dev/null
assert_url_contains "/app/projects/${PROJECT_SLUG}" "should land on project detail"
assert_url_not_contains "/create" "still on create form"
url="$(ab get url)"
assert_contains "$url" "$PROJECT_SLUG" "project slug missing from url ($url)"

snap="$(page_text)"
assert_contains "$snap" "$PROJECT_NAME" "project name not shown after create"
assert_not_contains "$snap" "Something went wrong"

step "open spec editor"
ab find role tab click --name "Spec" >/dev/null 2>&1 \
  || fail "Spec tab missing or click failed"
ab wait 800 >/dev/null
ab wait --load networkidle >/dev/null 2>&1 || ab wait 800 >/dev/null
assert_url_contains "/spec" "spec editor route"

step "paste minimal OpenAPI JSON"
minimal_openapi_json "$PROJECT_NAME" >"$SPEC_FILE"
# Spec editor is CodeMirror 6 (contenteditable .cm-content). agent-browser eval
# runs in an isolated world: page-world props (cmView) are INVISIBLE, but
# dispatched events cross worlds — so inject via synthetic ClipboardEvent paste.
# Wait for editor mount first (route shows skeleton while draft query loads).
editor_ready=""
for _ in $(seq 1 30); do
  if [[ "$(ab eval "!!document.querySelector('.cm-content')" 2>/dev/null | tail -1)" == "true" ]]; then
    editor_ready=1
    break
  fi
  ab wait 500 >/dev/null
done
[[ -n "$editor_ready" ]] || fail "CodeMirror editor never mounted"

b64="$(base64 -w0 "$SPEC_FILE" 2>/dev/null || base64 "$SPEC_FILE" | tr -d '\n')"
ab eval "(() => { const el=document.querySelector('.cm-content'); el.focus(); document.execCommand('selectAll'); const dt=new DataTransfer(); dt.setData('text/plain', atob('$b64')); el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})); return true; })()" >/dev/null \
  || fail "could not paste OpenAPI into CodeMirror editor"
ab wait 500 >/dev/null
filled="$(ab eval "document.querySelector('.cm-content').textContent.includes('openapi')" 2>/dev/null | tail -1)"
[[ "$filled" == "true" ]] || fail "editor content missing openapi after paste"

step "save draft"
# Autosave (2s debounce) may beat the button; click if enabled, else rely on autosave.
click_button "Save draft" || ab wait 2500 >/dev/null
# Toast or Saved state
ab wait 1500 >/dev/null
snap="$(page_text)"
if [[ "$snap" == *"Draft has errors"* || "$snap" == *"error"* && "$snap" == *"Issues"* ]]; then
  # Allow only if Issues badge is Clean or no error-level issues listed after save.
  :
fi
# Prefer positive signal
if [[ "$snap" != *"Draft saved"* && "$snap" != *"Saved"* && "$snap" != *"Clean"* ]]; then
  # re-snapshot after toast settle
  ab wait 1000 >/dev/null
  snap="$(page_text)"
fi
assert_not_contains "$snap" "Draft has errors" "draft validation failed"
assert_not_contains "$snap" "Could not save draft" "save draft mutation failed"
# Issues panel: no error badge preferred
if [[ "$snap" == *" error"* || "$snap" == *"errors"* ]]; then
  # If explicit error count badge shows, fail
  if [[ "$snap" =~ [1-9][0-9]*\ errors? ]]; then
    fail "issues panel reports errors after save"
  fi
fi
log "draft saved (or no error toast)"

step "test saved upstream reachability"
click_button "Test reachability" || fail "Test reachability button missing/disabled after draft save"
ab wait --text "Server responded successfully." 30 \
  || fail "saved upstream connection test did not pass"
ab wait 500 >/dev/null

step "publish 0.0.1"
click_button "Publish" || fail "Publish button missing/disabled after passing connection test"
ab wait --text "Publish version" 15
ab fill '#semver' "0.0.1" >/dev/null \
  || ab fill 'input#semver' "0.0.1" >/dev/null \
  || ab fill 'input[placeholder="0.1.0"]' "0.0.1" >/dev/null \
  || fail "semver input missing"
# Confirm publish inside dialog — must not hit outer DialogTrigger
click_dialog_button "Publish" || fail "confirm Publish click failed"
ab wait 2000 >/dev/null
snap="$(page_text)"
if [[ "$snap" != *"Published"* && "$snap" != *"v0.0.1"* && "$snap" != *"0.0.1"* ]]; then
  ab wait 2000 >/dev/null
  snap="$(page_text)"
fi
assert_not_contains "$snap" "Publish failed" "publish failed toast"
assert_not_contains "$snap" "Could not publish" "publish mutation error"
if [[ "$snap" != *"Published"* && "$snap" != *"0.0.1"* && "$snap" != *"v0.0.1"* ]]; then
  fail "no publish success toast/badge (expected Published / v0.0.1)"
fi
log "published 0.0.1"

step "make public from spec workflow"
click_button "Make public" || fail "spec visibility action missing"
ab wait --text "Make project public?" 10
click_dialog_button "Make public" || fail "confirm make public failed"
ab wait 2000 >/dev/null
snap="$(page_text)"
assert_not_contains "$snap" "Could not update visibility" "visibility mutation failed"
assert_not_contains "$snap" "Project is private" "project remained private after mutation"
assert_contains "$snap" "Make Private" "project did not become public"

step "assert catalogue lists project"
open_path "/catalogue"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 1200 >/dev/null
snap="$(page_text)"
assert_contains "$snap" "Catalogue" "catalogue heading missing"
if [[ "$snap" != *"$PROJECT_NAME"* && "$snap" != *"$PROJECT_SLUG"* ]]; then
  fail "catalogue does not list published project '$PROJECT_NAME' (app may lack live catalogue data)"
fi

log "02-publisher PASS name=$PROJECT_NAME slug=$PROJECT_SLUG"
