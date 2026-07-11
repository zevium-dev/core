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
# Create page can 500 once under cold Convex; retry load.
create_ready=0
for attempt in 1 2 3; do
  open_path "/app/projects/create"
  ab wait --load networkidle >/dev/null 2>&1 || ab wait 800 >/dev/null
  snap="$(page_text)"
  if [[ "$snap" == *"New project"* ]]; then
    create_ready=1
    break
  fi
  if [[ "$snap" == *"HTTPError"* || "$snap" == *"Something went wrong"* || "$snap" == *"500"* ]]; then
    log "create page error on attempt $attempt — retry"
    ab wait 1500 >/dev/null
    continue
  fi
  log "create page missing heading on attempt $attempt"
  ab wait 1000 >/dev/null
done
if (( create_ready == 0 )); then
  fail "New project form never loaded after retries"
fi

ab fill '#project-name' "$PROJECT_NAME" >/dev/null

# Scroll + click; fall back to native form.requestSubmit if still stuck.
if ! click_button "Create project" 'button[type="submit"]'; then
  log "Create project click failed — try form.requestSubmit"
  submit_form 'form' || fail "Create project submit failed"
fi

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
# Prefer UI tab / next-step CTA, fall back to direct URL.
if ab find role tab click --name "Spec" >/dev/null 2>&1 \
  || click_button "Edit OpenAPI spec" \
  || ab find text "Edit OpenAPI spec" click >/dev/null 2>&1; then
  ab wait 800 >/dev/null
else
  open_path "/app/projects/${PROJECT_SLUG}/spec"
fi
ab wait --load networkidle >/dev/null 2>&1 || ab wait 800 >/dev/null
assert_url_contains "/spec" "spec editor route"

step "paste minimal OpenAPI JSON"
minimal_openapi_json "$PROJECT_NAME" >"$SPEC_FILE"
# Spec editor is a bare monospace textarea.
if ! ab fill 'textarea.font-mono' "$(cat "$SPEC_FILE")" >/dev/null 2>&1; then
  # Fallback: first large textarea on page
  if ! ab fill 'textarea' "$(cat "$SPEC_FILE")" >/dev/null 2>&1; then
    # Last resort: JS set value + input event
    ab eval "$(cat <<'JS'
const t = document.querySelector('textarea.font-mono') || document.querySelector('textarea');
if (!t) throw new Error('no textarea');
t.focus();
t.value = '';
JS
)" >/dev/null
    # inject via stdin-safe path: write into page from file using base64
    b64="$(base64 -w0 "$SPEC_FILE" 2>/dev/null || base64 "$SPEC_FILE" | tr -d '\n')"
    ab eval "const t=document.querySelector('textarea.font-mono')||document.querySelector('textarea'); const v=atob('$b64'); const d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value'); d.set.call(t,v); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true})); t.value.length" >/dev/null \
      || fail "could not fill OpenAPI into editor"
  fi
fi
ab wait 500 >/dev/null

step "save draft"
click_button "Save draft" || fail "Save draft button missing"
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

step "publish 0.0.1"
click_button "Publish" || fail "Publish button missing/disabled (unsaved dirty?)"
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

step "make public"
# Leave spec tab to overview for visibility control
open_path "/app/projects/${PROJECT_SLUG}"
ab wait 1000 >/dev/null
snap="$(page_text)"
if [[ "$snap" == *"Make Private"* ]]; then
  log "already public"
else
  # Outer trigger: "Make Public"; dialog confirm: "Make public"
  click_button "Make Public" || fail "Make Public button missing"
  ab wait --text "Make project public" 10
  click_dialog_button "Make public" \
    || click_dialog_button "Make Public" \
    || fail "confirm make public failed"
  ab wait 2000 >/dev/null
  snap="$(page_text)"
  assert_not_contains "$snap" "Could not update visibility" "visibility mutation failed"
  # Require post-mutation UI: toast and/or trigger flipped to Make Private
  if [[ "$snap" != *"now public"* && "$snap" != *"Make Private"* ]]; then
    # one more settle for realtime badge
    ab wait 1500 >/dev/null
    snap="$(page_text)"
  fi
  if [[ "$snap" != *"now public"* && "$snap" != *"Make Private"* ]]; then
    fail "expected public visibility (toast 'now public' or button 'Make Private'); still private?"
  fi
fi

step "assert catalogue lists project"
open_path "/catalogue"
ab wait --load networkidle >/dev/null 2>&1 || ab wait 1200 >/dev/null
snap="$(page_text)"
assert_contains "$snap" "Catalogue" "catalogue heading missing"
if [[ "$snap" != *"$PROJECT_NAME"* && "$snap" != *"$PROJECT_SLUG"* ]]; then
  fail "catalogue does not list published project '$PROJECT_NAME' (app may lack live catalogue data)"
fi

log "02-publisher PASS name=$PROJECT_NAME slug=$PROJECT_SLUG"
