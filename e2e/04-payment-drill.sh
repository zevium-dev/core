#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-zevium-payment-drill}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

PAYMENT_DRILL_PHASE="${PAYMENT_DRILL_PHASE:-grant}"
PAYMENT_DRILL_STATE="${PAYMENT_DRILL_STATE:-$E2E_ARTIFACTS/payment-drill-state.json}"
export PAYMENT_DRILL_STATE
STRIPE_PROOF="$SCRIPT_DIR/stripe-provider-proof.mjs"
GRANT_CREDITS=100000
PARTIAL_REFUND_CREDITS=25000
REMAINING_REFUND_CREDITS=75000
grant_committed=false

cleanup() {
  local code="$?"
  if [[ -f "$PAYMENT_DRILL_STATE" ]]; then
    node "$STRIPE_PROOF" restore-webhook >/dev/null 2>&1 || true
  fi
  if (( code != 0 )) && [[ "$grant_committed" == true ]]; then
    node "$STRIPE_PROOF" refund cleanup >/dev/null 2>&1 || true
  fi
  close_browser
}
trap cleanup EXIT

on_error() {
  local code="$?" line="$1"
  trap - ERR
  fail "unexpected command failure at line $line (exit=$code)"
}
trap 'on_error "$LINENO"' ERR

: "${STRIPE_SECRET_KEY:?STRIPE_SECRET_KEY is required}"
if [[ "$STRIPE_SECRET_KEY" != sk_test_* ]]; then
  fail "payment drill requires a Stripe test-mode key"
fi
if [[ "$PAYMENT_DRILL_PHASE" != "grant" \
  && "$PAYMENT_DRILL_PHASE" != "refund" \
  && "$PAYMENT_DRILL_PHASE" != "cleanup" ]]; then
  fail "PAYMENT_DRILL_PHASE must be grant, refund, or cleanup"
fi

read_wallet_balance() {
  local raw
  raw="$(ab eval '
(() => {
  const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
  const label = Array.from(document.querySelectorAll("p,span,div"))
    .find((element) => norm(element.textContent) === "Wallet balance");
  if (!label || !label.parentElement) return "missing";
  const candidates = Array.from(label.parentElement.querySelectorAll("p,span"))
    .map((element) => norm(element.textContent))
    .filter((text) => text !== "Wallet balance" && /credits/i.test(text));
  const match = candidates.join(" ").match(/-?[0-9][0-9,]*/);
  return match ? match[0].replace(/,/g, "") : "missing";
})()
' 2>/dev/null | tr -d '"[:space:]')"
  [[ "$raw" =~ ^-?[0-9]+$ ]] || fail "wallet balance is not readable"
  printf '%s\n' "$raw"
}

wait_for_wallet_balance() {
  local expected="$1" timeout_s="${2:-120}" deadline balance
  deadline=$((SECONDS + timeout_s))
  while (( SECONDS < deadline )); do
    open_path "/app/billing"
    balance="$(read_wallet_balance)"
    if [[ "$balance" == "$expected" ]]; then
      printf '%s\n' "$balance"
      return 0
    fi
    sleep 2
  done
  fail "wallet balance did not become $expected within ${timeout_s}s (last=${balance:-missing})"
}

wait_for_wallet_below() {
  local ceiling="$1" timeout_s="${2:-120}" deadline balance
  deadline=$((SECONDS + timeout_s))
  while (( SECONDS < deadline )); do
    open_path "/app/billing"
    balance="$(read_wallet_balance)"
    if (( balance < ceiling )); then
      printf '%s\n' "$balance"
      return 0
    fi
    sleep 2
  done
  fail "wallet did not record paid usage below $ceiling within ${timeout_s}s"
}

sign_in_to_billing() {
  step "sign in to isolated staging"
  wait_for_url "$E2E_BASE_URL/" "200" 90
  ab open "$E2E_BASE_URL/" >/dev/null
  ab cookies clear >/dev/null
  sign_in
  open_path "/app/billing"
  wait_for_text "Buy credits" 30
}

run_grant_phase() {
  local wallet_before checkout_url checkout_id billing_url returned_checkout_id
  local expected_wallet wallet_after

  sign_in_to_billing
  wallet_before="$(read_wallet_balance)"
  node "$STRIPE_PROOF" record-balance walletBeforeGrant "$wallet_before"

  step "start real hosted Stripe Checkout"
  ab find role button click --name 'Buy $10.00' >/dev/null
  wait_for_url_pattern "https://checkout.stripe.com/" 30
  timeout 15s agent-browser wait --load domcontentloaded >/dev/null 2>&1 || true
  wait_for_text "Payment method" 30
  checkout_url="$(ab get url)"
  checkout_id="$(node -e 'const match=new URL(process.argv[1]).pathname.match(/cs_test_[A-Za-z0-9]+/); console.log(match?.[0] || "")' "$checkout_url")"
  [[ "$checkout_id" == cs_test_* ]] || fail "Stripe sandbox URL lacks Checkout Session id"
  node "$STRIPE_PROOF" record-provider-id checkoutSessionId "$checkout_id"
  grant_committed=true

  step "complete real Stripe sandbox card payment"
  if ab get count 'input[name="email"]' | grep -qv '^0$'; then
    ab fill 'input[name="email"]' "$E2E_EMAIL"
  fi
  if ab get count 'input[name="cardNumber"]' | grep -q '^0$'; then
    ab find role button click --name "Pay with card" >/dev/null
    ab wait 'input[name="cardNumber"]' >/dev/null || fail "card fields did not open"
  fi
  ab fill 'input[name="cardNumber"]' "4242424242424242"
  ab fill 'input[name="cardExpiry"]' "1234"
  ab fill 'input[name="cardCvc"]' "123"
  if ab get count 'input[name="billingName"]' | grep -qv '^0$'; then
    ab fill 'input[name="billingName"]' "Zevium CI"
  fi
  if ab get count 'input[name="billingPostalCode"]' | grep -qv '^0$'; then
    ab fill 'input[name="billingPostalCode"]' "10001"
  fi
  agent_ref="$(page_interactive | sed -nE 's/^[[:space:]]*- checkbox "I am an AI agent acting on behalf of someone else".*ref=([^],]+).*/\1/p' | head -1)"
  if [[ -n "$agent_ref" ]]; then
    ab check "@$agent_ref" >/dev/null \
      || fail "Stripe AI-agent disclosure checkbox could not be checked"
    stripe_controls="$(page_interactive)"
    if ! grep -F 'checkbox "I am an AI agent acting on behalf of someone else" [checked=true' \
      <<<"$stripe_controls" >/dev/null; then
      fail "Stripe AI-agent disclosure did not remain checked"
    fi
    instructions_ref="$(sed -nE 's/^[[:space:]]*- checkbox "I am an AI agent and have followed the instructions above".*ref=([^],]+).*/\1/p' <<<"$stripe_controls" | head -1)"
    [[ -n "$instructions_ref" ]] \
      || fail "Stripe AI-agent instruction acknowledgement is missing"
    ab check "@$instructions_ref" >/dev/null \
      || fail "Stripe AI-agent instructions could not be acknowledged"
    if ! page_interactive | grep -F 'checkbox "I am an AI agent and have followed the instructions above" [checked=true' >/dev/null; then
      fail "Stripe AI-agent instruction acknowledgement did not remain checked"
    fi
  fi
  ab scroll down 700 >/dev/null
  click_button "Pay" || fail "Stripe Pay button could not be clicked"
  wait_for_url_pattern "/app/billing?checkout=" 90

  billing_url="$(ab get url)"
  returned_checkout_id="$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("checkout") || "")' "$billing_url")"
  assert_eq "$returned_checkout_id" "$checkout_id" "checkout return changed Stripe session id"
  wait_for_text "Confirmed" 120

  step "verify immutable provider facts and exact Convex wallet grant"
  node "$STRIPE_PROOF" checkout
  expected_wallet=$((wallet_before + GRANT_CREDITS))
  wallet_after="$(wait_for_wallet_balance "$expected_wallet" 120)"
  node "$STRIPE_PROOF" record-balance walletAfterGrant "$wallet_after"
  grant_committed=false
  log "grant phase PASS wallet=$wallet_before->$wallet_after"
}

run_refund_phase() {
  local state_granted wallet_before partial_expected wallet_partial wallet_replayed
  local full_expected wallet_full consumed terminal_before terminal_url terminal_id
  local terminal_after

  [[ -f "$PAYMENT_DRILL_STATE" ]] || fail "payment drill state is missing"
  sign_in_to_billing

  step "expire a real unpaid Checkout and prove terminal recovery"
  terminal_before="$(read_wallet_balance)"
  ab find role button click --name 'Buy $10.00' >/dev/null
  wait_for_url_pattern "https://checkout.stripe.com/" 30
  terminal_url="$(ab get url)"
  terminal_id="$(node -e 'const match=new URL(process.argv[1]).pathname.match(/cs_test_[A-Za-z0-9]+/); console.log(match?.[0] || "")' "$terminal_url")"
  [[ "$terminal_id" == cs_test_* ]] || fail "terminal proof lacks Checkout Session id"
  node "$STRIPE_PROOF" record-provider-id terminalCheckoutSessionId "$terminal_id"
  node "$STRIPE_PROOF" expire-checkout
  open_path "/app/billing?checkout=$terminal_id"
  wait_for_text "Payment was not completed" 120
  wait_for_text "Not completed" 30
  terminal_after="$(read_wallet_balance)"
  assert_eq "$terminal_after" "$terminal_before" "expired Checkout changed wallet"

  state_granted="$(node -e 'const x=require(process.argv[1]); console.log(x.walletAfterGrant)' "$PAYMENT_DRILL_STATE")"
  [[ "$state_granted" =~ ^-?[0-9]+$ ]] || fail "grant wallet proof is missing"
  wallet_before="$(wait_for_wallet_below "$state_granted" 120)"
  consumed=$((state_granted - wallet_before))
  node "$STRIPE_PROOF" record-balance walletBeforeRefund "$wallet_before"

  step "force one real signed webhook delivery failure"
  node "$STRIPE_PROOF" begin-webhook-outage
  node "$STRIPE_PROOF" refund partial
  sleep 6
  open_path "/app/billing"
  assert_eq "$(read_wallet_balance)" "$wallet_before" \
    "refund reached Convex while webhook endpoint targeted intentional 404"

  step "restore endpoint, replay failed delivery, and prove exact reversal"
  node "$STRIPE_PROOF" prove-failed-delivery
  partial_expected=$((wallet_before - PARTIAL_REFUND_CREDITS))
  wallet_partial="$(wait_for_wallet_balance "$partial_expected" 120)"
  node "$STRIPE_PROOF" record-balance walletAfterPartialRefund "$wallet_partial"
  wait_for_text "25,000 credits refunded" 30

  step "replay signed provider webhook and prove idempotent balance"
  node "$STRIPE_PROOF" replay-refund
  sleep 4
  open_path "/app/billing"
  wallet_replayed="$(read_wallet_balance)"
  assert_eq "$wallet_replayed" "$wallet_partial" "webhook replay duplicated refund reversal"
  node "$STRIPE_PROOF" record-balance walletAfterReplay "$wallet_replayed"

  step "create remaining provider refund and prove full Convex reversal"
  node "$STRIPE_PROOF" refund remaining
  full_expected=$((wallet_partial - REMAINING_REFUND_CREDITS))
  wallet_full="$(wait_for_wallet_balance "$full_expected" 120)"
  node "$STRIPE_PROOF" record-balance walletAfterFullRefund "$wallet_full"
  wait_for_text "100,000 credits refunded" 30
  wait_for_text "Refunded" 30
  assert_eq "$wallet_full" "$((state_granted - GRANT_CREDITS - consumed))" \
    "full refund did not preserve exact paid-call usage"
  log "refund phase PASS consumed=$consumed wallet=$wallet_before->$wallet_full"
}

case "$PAYMENT_DRILL_PHASE" in
  grant)
    run_grant_phase
    ;;
  refund)
    run_refund_phase
    ;;
  cleanup)
    if [[ -f "$PAYMENT_DRILL_STATE" ]]; then
      node "$STRIPE_PROOF" restore-webhook
      node "$STRIPE_PROOF" refund cleanup
    else
      log "no payment state to recover"
    fi
    ;;
esac

log "04-payment-drill PASS phase=$PAYMENT_DRILL_PHASE"
