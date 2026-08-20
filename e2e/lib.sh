#!/usr/bin/env bash
# Shared helpers for Zevium browser E2E scripts (agent-browser).
# shellcheck disable=SC2034

set -euo pipefail

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:3000}"
E2E_ARTIFACTS="${E2E_ARTIFACTS:-$E2E_ROOT/artifacts}"
E2E_EMAIL="${E2E_EMAIL:-}"
E2E_PASSWORD="${E2E_PASSWORD:-}"
E2E_OTP="${E2E_OTP:-}"
E2E_SESSION="${E2E_SESSION:-zevium-e2e}"
E2E_STEP="${E2E_STEP:-unknown}"
E2E_VIEWPORT_WIDTH="${E2E_VIEWPORT_WIDTH:-1440}"
E2E_VIEWPORT_HEIGHT="${E2E_VIEWPORT_HEIGHT:-900}"
E2E_COLOR_SCHEME="${E2E_COLOR_SCHEME:-light}"
E2E_REDUCED_MOTION="${E2E_REDUCED_MOTION:-no-preference}"
E2E_RUN_ID="${E2E_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
E2E_OWNS_RUNTIME="${E2E_OWNS_RUNTIME:-0}"

# Resolve the agent-browser CLI without mutating PATH (workflow supply-chain
# audit forbids shell PATH overrides): PATH first so tests can stub the
# binary, then the workspace install for bare-shell CI steps.
E2E_AGENT_BROWSER="$(command -v agent-browser || true)"
if [[ -z "$E2E_AGENT_BROWSER" && -x "$E2E_ROOT/../node_modules/.bin/agent-browser" ]]; then
  E2E_AGENT_BROWSER="$E2E_ROOT/../node_modules/.bin/agent-browser"
fi
[[ -n "$E2E_AGENT_BROWSER" ]] || { printf '[e2e] agent-browser CLI not found; run pnpm install.\n' >&2; exit 1; }

if [[ -z "${E2E_RUNTIME_DIR:-}" ]]; then
  E2E_RUNTIME_DIR="$(mktemp -d /tmp/zevium-e2e-runtime.XXXXXX)"
  E2E_OWNS_RUNTIME=1
fi
E2E_RAW_DIR="${E2E_RAW_DIR:-$E2E_RUNTIME_DIR/raw}"
E2E_FIXTURES_DIR="${E2E_FIXTURES_DIR:-$E2E_RUNTIME_DIR/fixtures}"
E2E_MANIFEST_STATE="${E2E_MANIFEST_STATE:-$E2E_RUNTIME_DIR/manifest-state.json}"
E2E_EXPECTED_COMMIT="${E2E_EXPECTED_COMMIT:-}"

case "$E2E_COLOR_SCHEME" in
  light|dark) ;;
  *) printf '[e2e] E2E_COLOR_SCHEME must be light or dark.\n' >&2; exit 1 ;;
esac
case "$E2E_REDUCED_MOTION" in
  reduce|no-preference) ;;
  *) printf '[e2e] E2E_REDUCED_MOTION must be reduce or no-preference.\n' >&2; exit 1 ;;
esac
[[ "$E2E_VIEWPORT_WIDTH" =~ ^[0-9]+$ ]] || { printf '[e2e] invalid viewport width.\n' >&2; exit 1; }
[[ "$E2E_VIEWPORT_HEIGHT" =~ ^[0-9]+$ ]] || { printf '[e2e] invalid viewport height.\n' >&2; exit 1; }

assert_no_symlink_path() {
  local target="$1" current="/" part
  local absolute
  local -a parts=()
  absolute="$(realpath -ms "$target")"
  IFS='/' read -r -a parts <<<"${absolute#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current="${current%/}/$part"
    if [[ -L "$current" ]]; then
      printf '[e2e] unsafe symlink path rejected: %s\n' "$target" >&2
      exit 1
    fi
  done
}

assert_no_symlink_path "$E2E_ARTIFACTS"
assert_no_symlink_path "$E2E_RUNTIME_DIR"

# Isolate browser session for the whole suite/script run.
export AGENT_BROWSER_SESSION="$E2E_SESSION"

mkdir -p "$E2E_ARTIFACTS" "$E2E_RAW_DIR" "$E2E_FIXTURES_DIR"
chmod 700 "$E2E_ARTIFACTS" "$E2E_RUNTIME_DIR" "$E2E_RAW_DIR" "$E2E_FIXTURES_DIR"

ab() {
  # agent-browser can hang on a wedged native host; bound every call.
  timeout 60s "$E2E_AGENT_BROWSER" "$@"
}

ab_timeout() {
  local duration="$1"
  shift
  timeout "$duration" "$E2E_AGENT_BROWSER" "$@"
}

log() {
  printf '[e2e] %s\n' "$*"
}

step() {
  E2E_STEP="$1"
  log "→ $E2E_STEP"
}

require_auth_env() {
  local missing=()
  [[ -n "$E2E_EMAIL" ]] || missing+=("E2E_EMAIL")
  [[ -n "$E2E_PASSWORD" ]] || missing+=("E2E_PASSWORD")
  [[ -n "$E2E_OTP" ]] || missing+=("E2E_OTP")
  if (( ${#missing[@]} > 0 )); then
    printf '[e2e] auth lane requires environment secrets: %s\n' "${missing[*]}" >&2
    exit 1
  fi
}

secure_unlink() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || return 0
  if command -v shred >/dev/null 2>&1; then
    shred -u -- "$path"
  else
    unlink -- "$path"
  fi
}

cleanup_e2e_runtime() {
  [[ "$E2E_OWNS_RUNTIME" == "1" ]] || return 0
  case "$E2E_RUNTIME_DIR" in
    /tmp/zevium-e2e-runtime.*)
      if command -v shred >/dev/null 2>&1; then
        find "$E2E_RUNTIME_DIR" -type f -exec shred -u -- {} + 2>/dev/null || true
      else
        find "$E2E_RUNTIME_DIR" -type f -delete 2>/dev/null || true
      fi
      find "$E2E_RUNTIME_DIR" -depth -type d -empty -delete 2>/dev/null || true
      ;;
    *)
      printf '[e2e] refusing cleanup outside guarded runtime path: %s\n' "$E2E_RUNTIME_DIR" >&2
      ;;
  esac
}

sanitize_artifact() {
  local raw="$1" output="$2" mode="${3:-text}"
  if node "$E2E_ROOT/artifact-sanitizer.mjs" "$raw" "$output" "$mode"; then
    secure_unlink "$raw"
    return 0
  fi
  secure_unlink "$raw"
  return 1
}

redact_dom_for_artifact() {
  ab eval "
(() => {
  try { sessionStorage.removeItem('zevium:playground-api-key'); } catch (_) {}
  try { localStorage.removeItem('zevium:playground-api-key'); } catch (_) {}
  const sensitive = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}|(?:sk_|rk_|whsec_|zv_|ak_|cs_|pi_|re_|user_|org_|sess_)[A-Za-z0-9_-]{6,}|Bearer\\s+[A-Za-z0-9._~+/-]{8,}|(?:\\d[ -]*?){13,19})/gi;
  for (const input of document.querySelectorAll('input, textarea')) {
    input.value = '[redacted]';
    input.setAttribute('value', '[redacted]');
  }
  for (const editable of document.querySelectorAll('[contenteditable]')) editable.textContent = '[redacted]';
  for (const image of document.querySelectorAll('img')) image.style.visibility = 'hidden';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) walker.currentNode.nodeValue = (walker.currentNode.nodeValue || '').replace(sensitive, '[redacted]');
  return true;
})()
" >/dev/null 2>&1
}

fail() {
  local msg="${1:-assertion failed}"
  local ts slug raw_shot raw_url raw_snapshot
  ts="$(date +%Y%m%d-%H%M%S)-$(date +%N)"
  slug="$(printf '%s' "$E2E_STEP" | tr -cs '[:alnum:]._-' '_' | cut -c1-80)"
  raw_shot="$E2E_RAW_DIR/${ts}-${slug}.raw.png"
  raw_url="$E2E_RAW_DIR/${ts}-${slug}.url.raw.txt"
  raw_snapshot="$E2E_RAW_DIR/${ts}-${slug}.snapshot.raw.txt"
  if redact_dom_for_artifact; then
    # Pixel evidence has no trustworthy generic sanitizer. Keep any capture in
    # private runtime storage and destroy it; publish only verified text.
    if ab screenshot "$raw_shot" >/dev/null 2>&1; then
      secure_unlink "$raw_shot"
    fi
    if ab get url >"$raw_url" 2>/dev/null; then
      sanitize_artifact "$raw_url" "$E2E_ARTIFACTS/${ts}-${slug}.url.txt" \
        || secure_unlink "$raw_url"
    fi
    if ab snapshot >"$raw_snapshot" 2>/dev/null; then
      sanitize_artifact "$raw_snapshot" "$E2E_ARTIFACTS/${ts}-${slug}.snapshot.txt" \
        || secure_unlink "$raw_snapshot"
    fi
  else
    secure_unlink "$raw_shot"
    secure_unlink "$raw_url"
    secure_unlink "$raw_snapshot"
    printf '[e2e] evidence capture aborted: DOM redaction failed\n' >&2
  fi
  printf '[e2e] FAIL: %s\n' "$msg" >&2
  printf '[e2e] verified text evidence directory: %s\n' "$E2E_ARTIFACTS" >&2
  exit 1
}

assert_eq() {
  local got="$1" want="$2"
  local msg="${3:-expected \"$want\", got \"$got\"}"
  if [[ "$got" != "$want" ]]; then
    fail "$msg (got='$got' want='$want')"
  fi
}

assert_contains() {
  local hay="$1" needle="$2"
  local msg="${3:-missing \"$needle\"}"
  if [[ "$hay" != *"$needle"* ]]; then
    fail "$msg"
  fi
}

assert_not_contains() {
  local hay="$1" needle="$2"
  local msg="${3:-unexpected \"$needle\"}"
  if [[ "$hay" == *"$needle"* ]]; then
    fail "$msg"
  fi
}

assert_url_contains() {
  local needle="$1"
  local msg="${2:-url missing \"$needle\"}"
  local url
  url="$(ab get url)"
  assert_contains "$url" "$needle" "$msg (url=$url)"
}

assert_url_not_contains() {
  local needle="$1"
  local msg="${2:-url still has \"$needle\"}"
  local url
  url="$(ab get url)"
  assert_not_contains "$url" "$needle" "$msg (url=$url)"
}

# Poll until curl gets HTTP 2xx (or optional expected code).
wait_for_url() {
  local url="$1"
  local expect_code="${2:-}"
  local timeout_s="${3:-60}"
  local interval_s="${4:-1}"
  local elapsed=0 code

  log "wait_for_url $url (timeout=${timeout_s}s)"
  while (( elapsed < timeout_s )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
    if [[ -n "$expect_code" ]]; then
      if [[ "$code" == "$expect_code" ]]; then
        log "wait_for_url ok code=$code"
        return 0
      fi
    else
      if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
        log "wait_for_url ok code=$code"
        return 0
      fi
    fi
    sleep "$interval_s"
    elapsed=$((elapsed + interval_s))
  done
  fail "wait_for_url timeout after ${timeout_s}s (last code=${code:-none}) url=$url"
}

page_text() {
  # Full accessibility snapshot (includes text nodes).
  ab snapshot 2>/dev/null || true
}

page_interactive() {
  ab snapshot -i 2>/dev/null || true
}

wait_for_text() {
  local needle="$1"
  local timeout_s="${2:-25}"
  ab wait --text "$needle" --timeout "$((timeout_s * 1000))" >/dev/null 2>&1 \
    || fail "text not found within ${timeout_s}s: $needle"
}

wait_for_url_pattern() {
  local pattern="$1"
  local timeout_s="${2:-30}"
  local deadline url
  deadline=$((SECONDS + timeout_s))
  while (( SECONDS < deadline )); do
    url="$(ab get url 2>/dev/null || true)"
    # Prefer substring when pattern looks like a path fragment; also try ab wait once.
    case "$pattern" in
      *\***)
        # Convert simple ** globs to bash pattern matching on path.
        # e.g. **/app/projects/** → */app/projects/*
        local bash_pat
        bash_pat="$(printf '%s' "$pattern" | sed 's/\*\*/\*/g')"
        # Runtime route pattern intentionally uses bash glob matching.
        # shellcheck disable=SC2053
        if [[ "$url" == $bash_pat ]]; then
          return 0
        fi
        # Also accept substring of non-wildcard core if present.
        local core
        core="$(printf '%s' "$pattern" | sed -E 's/^\*\*?//; s/\*\*?$//; s/\*\*//g')"
        if [[ -n "$core" && "$url" == *"$core"* ]]; then
          return 0
        fi
        ;;
      *)
        if [[ "$url" == *"$pattern"* ]]; then
          return 0
        fi
        ;;
    esac
    ab wait 300 >/dev/null 2>&1 || sleep 0.3
  done
  fail "url pattern not matched within ${timeout_s}s: $pattern (url=$(ab get url 2>/dev/null || true))"
}

open_path() {
  local path="$1"
  local url="$E2E_BASE_URL$path"
  ab open "$url" >/dev/null
  ab wait --load networkidle >/dev/null 2>&1 || ab wait 500 >/dev/null
}

configure_browser_context() {
  ab set viewport "$E2E_VIEWPORT_WIDTH" "$E2E_VIEWPORT_HEIGHT" >/dev/null
  if [[ "$E2E_REDUCED_MOTION" == "reduce" ]]; then
    ab set media "$E2E_COLOR_SCHEME" reduced-motion >/dev/null
  else
    ab set media "$E2E_COLOR_SCHEME" >/dev/null
  fi
}

use_browser_session() {
  local session="$1"
  close_browser
  E2E_SESSION="$session"
  export AGENT_BROWSER_SESSION="$session"
  configure_browser_context
}

assert_anonymous_identity() {
  local present
  present="$(ab eval "Boolean(window.Clerk?.user?.id)" 2>/dev/null || true)"
  [[ "$present" != *"true"* ]] || fail "anonymous context contains a Clerk user"
}

record_browser_contract() {
  local lane="$1" context="$2" auth_mode="$3" raw
  raw="$(ab eval "
JSON.stringify({
  viewport: {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  },
  colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  auth: {
    userId: window.Clerk?.user?.id ?? null,
    organizationId: window.Clerk?.organization?.id ?? null,
    role: window.Clerk?.organization?.membership?.role ?? null
  }
})
" 2>/dev/null)" || fail "could not observe browser evidence contract"
  printf '%s' "$raw" | node "$E2E_ROOT/evidence-manifest.mjs" \
    contract "$E2E_MANIFEST_STATE" \
    "--lane=$lane" \
    "--context=$context" \
    "--auth-mode=$auth_mode" \
    "--width=$E2E_VIEWPORT_WIDTH" \
    "--height=$E2E_VIEWPORT_HEIGHT" \
    "--color=$E2E_COLOR_SCHEME" \
    "--motion=$E2E_REDUCED_MOTION" \
    || fail "browser evidence contract did not match declared context"
}

verify_target_commit() {
  local lane="$1" html observed
  [[ "$E2E_EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
    || fail "E2E_EXPECTED_COMMIT must be an explicit full lowercase Git SHA"
  html="$(curl -fsS --max-time 15 "$E2E_BASE_URL/")" \
    || fail "could not fetch target build metadata"
  observed="$(printf '%s' "$html" | node -e '
let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { source += chunk; });
process.stdin.on("end", () => {
  const tag = source.match(/<meta\b[^>]*\bname=["\x27]zevium-build["\x27][^>]*>/i)?.[0] ?? "";
  const sha = tag.match(/\bcontent=["\x27]([0-9a-f]{40})["\x27]/i)?.[1] ?? "";
  process.stdout.write(sha);
});
')"
  [[ "$observed" == "$E2E_EXPECTED_COMMIT" ]] \
    || fail "target build mismatch for $lane (expected=$E2E_EXPECTED_COMMIT observed=${observed:-missing})"
  node "$E2E_ROOT/evidence-manifest.mjs" target "$E2E_MANIFEST_STATE" \
    "--lane=$lane" \
    "--base-url=$E2E_BASE_URL" \
    "--expected=$E2E_EXPECTED_COMMIT" \
    "--observed=$observed" \
    || fail "could not record target build identity"
}

record_manifest_result() {
  local lane="$1" status="$2" duration="$3" proof="$4"
  node "$E2E_ROOT/evidence-manifest.mjs" result "$E2E_MANIFEST_STATE" \
    "--lane=$lane" "--status=$status" "--duration=$duration" "--proof=$proof"
}

build_evidence_manifest() {
  local output="$1"
  node "$E2E_ROOT/evidence-manifest.mjs" build "$E2E_MANIFEST_STATE" \
    "--output=$output" \
    "--repo=$(cd "$E2E_ROOT/.." && pwd)" \
    "--base-url=$E2E_BASE_URL" \
    "--expected-commit=$E2E_EXPECTED_COMMIT" \
    "--run-id=$E2E_RUN_ID"
}

# Scroll target into view then click. agent-browser click is silent no-op
# when the button sits below the fold without scrollIntoView first.
# Usage: click_button "Create project" ['button[type=submit]']
click_button() {
  local name="$1"
  local css="${2:-}"
  local js_name js_css

  js_name="$(printf '%s' "$name" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  if [[ -n "$css" ]]; then
    js_css="$(printf '%s' "$css" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  else
    js_css='""'
  fi

  # Prefer exact button text match; optional CSS fallback for scroll target.
  ab eval "
(() => {
  const name = ${js_name};
  const css = ${js_css};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const want = norm(name);
  let el = null;
  if (css) {
    try { el = document.querySelector(css); } catch (_) {}
  }
  if (!el) {
    const buttons = Array.from(document.querySelectorAll('button, [role=\"button\"], input[type=\"submit\"]'));
    el = buttons.find((b) => {
      const label = norm(b.innerText || b.textContent || b.getAttribute('aria-label') || b.value || '');
      return label === want || label.includes(want);
    }) || null;
  }
  if (!el) return 'missing:' + want;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  return 'ok';
})()
" >/dev/null 2>&1 || true

  if ab find role button click --name "$name" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -n "$css" ]] && ab click "$css" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Click a button inside the open dialog (role=dialog). Avoids agent-browser
# matching the DialogTrigger outside and toggling the dialog closed.
click_dialog_button() {
  local name="$1"
  local js_name result
  js_name="$(printf '%s' "$name" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  result="$(ab eval "
(() => {
  const name = ${js_name};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const want = norm(name);
  const dialog = document.querySelector('[role=\"dialog\"]');
  if (!dialog) return 'no-dialog';
  const buttons = Array.from(dialog.querySelectorAll('button, [role=\"button\"]'));
  const el = buttons.find((b) => {
    const label = norm(b.innerText || b.textContent || b.getAttribute('aria-label') || '');
    return label === want;
  }) || buttons.find((b) => {
    const label = norm(b.innerText || b.textContent || b.getAttribute('aria-label') || '');
    return label.includes(want);
  });
  if (!el) return 'missing:' + want + ' buttons=' + buttons.map((b) => norm(b.innerText || b.textContent)).join('|');
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  el.click();
  return 'ok';
})()
" 2>/dev/null || true)"
  if [[ "$result" == *ok* ]]; then
    return 0
  fi
  log "click_dialog_button failed: $result"
  if ab find role button click --name "$name" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Form submit via native requestSubmit (works when button click is flaky).
submit_form() {
  local css="${1:-form}"
  local js_css
  js_css="$(printf '%s' "$css" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  ab eval "
(() => {
  const form = document.querySelector(${js_css});
  if (!form) return 'no-form';
  form.scrollIntoView({ block: 'center' });
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.submit();
  return 'ok';
})()
" >/dev/null 2>&1
}

# True if current session is already signed in (can load /app without auth bounce).
is_signed_in() {
  open_path "/app"
  ab wait 800 >/dev/null 2>&1 || true
  local url
  url="$(ab get url)"
  if [[ "$url" == *"/sign-in"* ]]; then
    return 1
  fi
  if [[ "$url" == *"/app"* ]]; then
    return 0
  fi
  return 1
}

# Clerk multi-step: email → password → environment-provided verification code.
# NEVER name-click "Continue" (fuzzy-matches "Continue with Google").
# CSS form submit clicks are inert on Clerk — focus input then press Enter.
# Short-circuits when session already authenticated.
sign_in() {
  step "sign_in"
  require_auth_env
  if is_signed_in; then
    log "already signed in — skip credentials"
    return 0
  fi

  open_path "/sign-in"
  ab wait --load networkidle >/dev/null 2>&1 || true
  ab wait 500 >/dev/null

  local deadline url snap clerk_user has_pw_field has_id_field
  local filled_identifier=0 filled_password=0 filled_otp=0
  deadline=$((SECONDS + 90))

  while (( SECONDS < deadline )); do
    url="$(ab get url 2>/dev/null || true)"
    snap="$(page_text)"
    clerk_user="$(ab eval "window.Clerk?.user?.id ?? ''" 2>/dev/null || true)"
    # Strip quotes/whitespace from eval output
    clerk_user="${clerk_user//\"/}"
    clerk_user="$(printf '%s' "$clerk_user" | tr -d '[:space:]')"

    # Success: Clerk user present, or authenticated /app route.
    if [[ -n "$clerk_user" ]]; then
      log "Clerk user present — signed in"
      open_path "/app"
      ab wait --load networkidle >/dev/null 2>&1 || ab wait 1200 >/dev/null
      url="$(ab get url)"
      if [[ "$url" == *"/sign-in"* ]]; then
        fail "Clerk user set but /app still bounces to sign-in (url=$url)"
      fi
      assert_url_contains "/app" "expected /app shell after sign_in"
      snap="$(page_text)"
      assert_not_contains "$snap" "Something went wrong" "app shell errored after sign_in"
      log "signed in → $url"
      return 0
    fi

    if [[ "$url" == *"/app"* && "$url" != *"/sign-in"* ]]; then
      log "signed in → $url"
      snap="$(page_text)"
      assert_not_contains "$snap" "Something went wrong" "app shell errored after sign_in"
      return 0
    fi

    # Landing after password without OTP — hop to /app and recheck.
    if [[ "$url" == "$E2E_BASE_URL/" || "$url" == "$E2E_BASE_URL" || "$url" == "${E2E_BASE_URL}/" ]]; then
      open_path "/app"
      ab wait 1000 >/dev/null
      continue
    fi

    # OTP / client-trust verification (auto-submits on fill).
    if (( filled_otp == 0 )) && {
      [[ "$snap" == *"Check your email"* \
        || "$snap" == *"verification code"* \
        || "$snap" == *"Enter verification code"* \
        || "$snap" == *"Verify your email"* \
        || "$url" == *"client-trust"* \
        || "$url" == *"/factor-two"* ]]
    }; then
      log "OTP screen detected — entering environment-provided code"
      if ab fill 'input' "$E2E_OTP" >/dev/null 2>&1 \
        || ab fill 'input[autocomplete="one-time-code"]' "$E2E_OTP" >/dev/null 2>&1 \
        || ab fill 'input[inputmode="numeric"]' "$E2E_OTP" >/dev/null 2>&1 \
        || ab fill 'input[name="code"]' "$E2E_OTP" >/dev/null 2>&1; then
        :
      else
        ab focus 'input' >/dev/null 2>&1 || true
        ab keyboard type "$E2E_OTP" >/dev/null 2>&1 || true
      fi
      filled_otp=1
      ab wait 2000 >/dev/null
      continue
    fi

    # Detect real fields via DOM (body text "Password" can appear without a field).
    has_pw_field="$(ab eval "!!document.querySelector('input[name=\"password\"], input[type=\"password\"]')" 2>/dev/null || true)"
    has_id_field="$(ab eval "!!document.querySelector('input[name=\"identifier\"], input[type=\"email\"]')" 2>/dev/null || true)"

    # Identifier first when present (first screen may also mention Password in text — ignore it).
    if (( filled_identifier == 0 )) && [[ "$has_id_field" == *"true"* ]]; then
      log "filled identifier — submit via Enter"
      ab fill 'input[name="identifier"]' "$E2E_EMAIL" >/dev/null 2>&1 \
        || ab fill 'input[type="email"]' "$E2E_EMAIL" >/dev/null 2>&1 \
        || fail "could not fill identifier"
      ab focus 'input[name="identifier"]' >/dev/null 2>&1 \
        || ab focus 'input[type="email"]' >/dev/null 2>&1 \
        || true
      ab press Enter >/dev/null 2>&1 || true
      filled_identifier=1
      ab wait 1500 >/dev/null
      continue
    fi

    # Password factor once password input exists (factor-one; factor-one may skip on trusted client).
    if (( filled_password == 0 )) && [[ "$has_pw_field" == *"true"* ]]; then
      log "filled password — submit via Enter"
      ab fill 'input[name="password"]' "$E2E_PASSWORD" >/dev/null 2>&1 \
        || ab fill 'input[type="password"]' "$E2E_PASSWORD" >/dev/null 2>&1 \
        || fail "could not fill password"
      ab focus 'input[name="password"]' >/dev/null 2>&1 \
        || ab focus 'input[type="password"]' >/dev/null 2>&1 \
        || true
      ab press Enter >/dev/null 2>&1 || true
      filled_password=1
      ab wait 1500 >/dev/null
      continue
    fi

    # Retry identifier submit if still stuck on identifier form after failed advance.
    if (( filled_identifier == 1 && filled_password == 0 && filled_otp == 0 )) \
      && [[ "$has_id_field" == *"true"* && "$has_pw_field" != *"true"* \
        && ( "$url" == *"/sign-in"* || "$snap" == *"Email address"* ) ]]; then
      log "retry identifier Enter"
      ab focus 'input[name="identifier"]' >/dev/null 2>&1 \
        || ab focus 'input[type="email"]' >/dev/null 2>&1 \
        || true
      ab press Enter >/dev/null 2>&1 || true
      ab wait 1500 >/dev/null
      continue
    fi

    ab wait 400 >/dev/null
  done

  # Final settle: hit /app and require authenticated shell.
  open_path "/app"
  ab wait 1500 >/dev/null
  url="$(ab get url)"
  clerk_user="$(ab eval "window.Clerk?.user?.id ?? ''" 2>/dev/null || true)"
  clerk_user="${clerk_user//\"/}"
  clerk_user="$(printf '%s' "$clerk_user" | tr -d '[:space:]')"
  if [[ "$url" == *"/sign-in"* ]]; then
    fail "still on sign-in after credentials and verification (url=$url)"
  fi
  if [[ "$url" != *"/app"* ]]; then
    fail "expected /app after sign_in (url=$url)"
  fi
  snap="$(page_text)"
  assert_not_contains "$snap" "Something went wrong" "app shell errored after sign_in"
  log "signed in → $url"
}

close_browser() {
  ab eval "
(() => {
  try { sessionStorage.removeItem('zevium:playground-api-key'); } catch (_) {}
  try { localStorage.removeItem('zevium:playground-api-key'); } catch (_) {}
  for (const input of document.querySelectorAll('input, textarea')) {
    input.value = '';
    input.setAttribute('value', '');
  }
  return true;
})()
" >/dev/null 2>&1 || true
  ab close >/dev/null 2>&1 || true
}

# Unique-ish stamp for project names/slugs.
e2e_stamp() {
  date +%Y%m%d%H%M%S
}

# Minimal valid OpenAPI for publisher golden path.
minimal_openapi_json() {
  local title="${1:-E2E Weather}"
  cat <<EOF
{
  "openapi": "3.1.0",
  "info": {
    "title": $(printf '%s' "$title" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
    "version": "0.0.1"
  },
  "servers": [{ "url": "https://postman-echo.com" }],
  "paths": {
    "/get": {
      "get": {
        "operationId": "httpbinGet",
        "summary": "Echo GET",
        "x-zevium-cost": 1,
        "responses": {
          "200": { "description": "OK" }
        }
      }
    }
  }
}
EOF
}
