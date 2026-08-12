#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-zevium-payment-drill}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

PAYMENT_DRILL_PHASE="${PAYMENT_DRILL_PHASE:-grant}"
PAYMENT_DRILL_STATE="${PAYMENT_DRILL_STATE:-$E2E_ARTIFACTS/payment-drill-state.json}"
export PAYMENT_DRILL_STATE
PAYMENT_PROOF_REPORT="${PAYMENT_PROOF_REPORT:-$E2E_ARTIFACTS/payment-proof-report.json}"
export PAYMENT_PROOF_REPORT
STRIPE_PROOF="$SCRIPT_DIR/stripe-provider-proof.mjs"
ISOLATED_RUNNER="$SCRIPT_DIR/run-isolated.mjs"
NODE_BIN="$(command -v node)"
GRANT_CREDITS=100000
PARTIAL_REFUND_CREDITS=25000

isolated() {
  local mode="$1"
  shift
  "$NODE_BIN" "$ISOLATED_RUNNER" "$mode" -- "$@"
}

state_exec() {
  isolated state "$@"
}

state_proof() {
  isolated state "$NODE_BIN" "$STRIPE_PROOF" "$@"
}

provider_proof() {
  isolated provider "$NODE_BIN" "$STRIPE_PROOF" "$@"
}

ledger_proof() {
  isolated ledger "$NODE_BIN" "$STRIPE_PROOF" "$@"
}

cleanup() {
  local code="$?"
  if (( code != 0 )) && [[ "$PAYMENT_DRILL_PHASE" != "cleanup" ]] \
    && [[ -f "$PAYMENT_DRILL_STATE" ]]; then
    ledger_proof record-recovery-baseline >/dev/null 2>&1 || true
    provider_proof recover-provider >/dev/null 2>&1 || true
    ledger_proof recover-ledger >/dev/null 2>&1 || true
    provider_proof compensate-app-transfer >/dev/null 2>&1 || true
    ledger_proof wait-app-compensation >/dev/null 2>&1 || true
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

: "${STRIPE_CHECKOUT_PROOF_KEY:?STRIPE_CHECKOUT_PROOF_KEY is required}"
: "${STRIPE_CONNECT_PROOF_KEY:?STRIPE_CONNECT_PROOF_KEY is required}"
: "${STRIPE_WEBHOOK_ADMIN_KEY:?STRIPE_WEBHOOK_ADMIN_KEY is required}"
: "${E2E_PUBLISHER_CLERK_ORG_ID:?E2E_PUBLISHER_CLERK_ORG_ID is required}"
: "${STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID:?STRIPE_CONNECT_SETTLEMENT_ACCOUNT_ID is required}"
: "${STRIPE_CONNECT_PLATFORM_ACCOUNT_ID:?STRIPE_CONNECT_PLATFORM_ACCOUNT_ID is required}"
if [[ ! "$STRIPE_CHECKOUT_PROOF_KEY" =~ ^rk_test_ ]]; then
  fail "payment drill requires a restricted Stripe checkout test key"
fi
if [[ ! "$STRIPE_WEBHOOK_ADMIN_KEY" =~ ^rk_test_ ]]; then
  fail "payment drill requires a restricted Stripe webhook-admin test key"
fi
if [[ ! "$STRIPE_CONNECT_PROOF_KEY" =~ ^rk_test_ ]]; then
  fail "payment drill requires a restricted Stripe Connect test key"
fi
if [[ "$PAYMENT_DRILL_PHASE" != "grant" \
  && "$PAYMENT_DRILL_PHASE" != "refund" \
  && "$PAYMENT_DRILL_PHASE" != "cleanup" ]]; then
  fail "PAYMENT_DRILL_PHASE must be grant, refund, or cleanup"
fi

active_clerk_org_id() {
  local raw
  raw="$(ab eval 'window.Clerk?.organization?.id ?? ""' 2>/dev/null || true)"
  printf '%s' "$raw" | tr -d '"[:space:]'
}

assert_exact_active_org() {
  local active
  active="$(active_clerk_org_id)"
  assert_eq "$active" "$E2E_PUBLISHER_CLERK_ORG_ID" \
    "browser active organization changed"
}

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
  assert_exact_active_org
  open_path "/app/billing"
  wait_for_text "Buy credits" 30
}

run_grant_phase() {
  local wallet_before checkout_url checkout_id billing_url returned_checkout_id
  local expected_wallet wallet_after

  ledger_proof verify-deployments
  sign_in_to_billing
  wallet_before="$(read_wallet_balance)"
  assert_eq "$wallet_before" "0" \
    "publisher proof fixture must start with zero consumer credits"
  state_proof record-balance walletBeforeGrant "$wallet_before"

  step "start real hosted Stripe Checkout"
  ab find role button click --name "Buy \$10.00" >/dev/null
  wait_for_url_pattern "https://checkout.stripe.com/" 30
  ab_timeout 15s wait --load domcontentloaded >/dev/null 2>&1 || true
  wait_for_text "Payment method" 30
  checkout_url="$(ab get url)"
  checkout_id="$(state_exec "$NODE_BIN" -e 'const match=new URL(process.argv[1]).pathname.match(/cs_test_[A-Za-z0-9]+/); console.log(match?.[0] || "")' "$checkout_url")"
  [[ "$checkout_id" == cs_test_* ]] || fail "Stripe sandbox URL lacks Checkout Session id"
  state_proof record-provider-id checkoutSessionId "$checkout_id"

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
  returned_checkout_id="$(state_exec "$NODE_BIN" -e 'console.log(new URL(process.argv[1]).searchParams.get("checkout") || "")' "$billing_url")"
  assert_eq "$returned_checkout_id" "$checkout_id" "checkout return changed Stripe session id"
  wait_for_text "Confirmed" 120

  step "verify immutable provider facts and exact Convex wallet grant"
  provider_proof checkout
  grant_event_id="$(state_proof state-field grantEventId)"
  ledger_proof wait-ledger grant "$grant_event_id" 1 0
  ledger_wallet="$(state_proof state-field ledgerSnapshots.grant.wallet.balance)"
  expected_wallet=$((wallet_before + GRANT_CREDITS))
  assert_eq "$ledger_wallet" "$expected_wallet" "Convex grant projection changed pack value"
  wallet_after="$(wait_for_wallet_balance "$ledger_wallet" 120)"
  state_proof record-balance walletAfterGrant "$wallet_after"
  log "grant phase PASS wallet=$wallet_before->$wallet_after"
}

run_refund_phase() {
  local state_granted wallet_before wallet_partial wallet_replayed wallet_full
  local consumed terminal_before terminal_url terminal_id terminal_after
  local partial_event_id full_event_id

  [[ -f "$PAYMENT_DRILL_STATE" ]] || fail "payment drill state is missing"
  sign_in_to_billing

  step "exercise authenticated v2 onboarding and publisher transfer app actions"
  ledger_proof app-baseline
  open_path "/app/earnings?onboarding=refresh"
  wait_for_url_pattern "https://connect.stripe.com/" 45
  onboarding_url="$(ab get url)"
  state_proof record-app-onboarding "$onboarding_url" \
    "$E2E_PUBLISHER_CLERK_ORG_ID"
  provider_proof verify-app-onboarding
  open_path "/app/earnings"
  wait_for_text "Earnings" 30
  assert_exact_active_org
  click_button "Transfer available earnings" \
    || fail "publisher transfer action is missing or disabled"
  wait_for_text "Publisher transfer submitted to Stripe." 60
  state_proof record-app-transfer-ui "$E2E_PUBLISHER_CLERK_ORG_ID"
  ledger_proof wait-app-transfer
  provider_proof verify-app-transfer
  ledger_proof wait-app-transfer-webhook

  step "expire a real unpaid Checkout and prove terminal recovery"
  terminal_before="$(read_wallet_balance)"
  ab find role button click --name "Buy \$10.00" >/dev/null
  wait_for_url_pattern "https://checkout.stripe.com/" 30
  terminal_url="$(ab get url)"
  terminal_id="$(state_exec "$NODE_BIN" -e 'const match=new URL(process.argv[1]).pathname.match(/cs_test_[A-Za-z0-9]+/); console.log(match?.[0] || "")' "$terminal_url")"
  [[ "$terminal_id" == cs_test_* ]] || fail "terminal proof lacks Checkout Session id"
  state_proof record-provider-id terminalCheckoutSessionId "$terminal_id"
  provider_proof expire-checkout
  open_path "/app/billing?checkout=$terminal_id"
  wait_for_text "Payment was not completed" 120
  wait_for_text "Not completed" 30
  terminal_after="$(read_wallet_balance)"
  assert_eq "$terminal_after" "$terminal_before" "expired Checkout changed wallet"

  state_granted="$(state_proof state-field walletAfterGrant)"
  [[ "$state_granted" =~ ^-?[0-9]+$ ]] || fail "grant wallet proof is missing"
  state_proof record-usage-proof \
    "$E2E_ARTIFACTS/gateway-paid-call-proof.json"
  ledger_proof wait-usage
  wallet_before="$(state_proof state-field ledgerSnapshots.usage.wallet.balance)"
  (( wallet_before < state_granted )) \
    || fail "paid journey did not settle usage below granted wallet"
  wait_for_wallet_balance "$wallet_before" 120 >/dev/null
  consumed=$((state_granted - wallet_before))

  step "install isolated signed-webhook failure canary"
  provider_proof begin-webhook-canary
  provider_proof refund partial
  partial_event_id="$(state_proof state-field partialRefundEventId)"
  ledger_proof wait-ledger partial "$partial_event_id" 1 \
    "$PARTIAL_REFUND_CREDITS" usage 1
  wallet_partial="$(state_proof state-field ledgerSnapshots.partial.wallet.balance)"
  wait_for_wallet_balance "$wallet_partial" 120 >/dev/null
  wait_for_text "25,000 credits refunded" 30

  step "prove exact failed canary, replay canonical receipt, and verify idempotency"
  provider_proof prove-canary-and-replay
  ledger_proof wait-ledger replay "$partial_event_id" 2 \
    "$PARTIAL_REFUND_CREDITS" partial 2
  wallet_replayed="$(state_proof state-field ledgerSnapshots.replay.wallet.balance)"
  assert_eq "$wallet_replayed" "$wallet_partial" "webhook replay duplicated refund reversal"
  wait_for_wallet_balance "$wallet_replayed" 120 >/dev/null

  step "create remaining provider refund and prove full Convex reversal"
  provider_proof refund remaining
  full_event_id="$(state_proof state-field fullRefundEventId)"
  ledger_proof wait-ledger full "$full_event_id" 1 "$GRANT_CREDITS" replay 1
  wallet_full="$(state_proof state-field ledgerSnapshots.full.wallet.balance)"
  wait_for_wallet_balance "$wallet_full" 120 >/dev/null
  wait_for_text "100,000 credits refunded" 30
  wait_for_text "Refunded" 30
  provider_proof cleanup-webhook-canary
  log "refund phase PASS consumed=$consumed wallet=$wallet_before->$wallet_full"
}

run_cleanup_phase() {
  local cleanup_failed=0
  ledger_proof record-recovery-baseline || cleanup_failed=1
  provider_proof recover-provider || cleanup_failed=1
  ledger_proof recover-ledger || cleanup_failed=1
  provider_proof cleanup-webhook-canary || cleanup_failed=1
  provider_proof compensate-app-transfer || cleanup_failed=1
  ledger_proof wait-app-compensation || cleanup_failed=1
  ledger_proof finalize-acceptance || cleanup_failed=1
  (( cleanup_failed == 0 )) || fail "payment/provider compensation did not fully reconcile"
}

case "$PAYMENT_DRILL_PHASE" in
  grant)
    run_grant_phase
    ;;
  refund)
    run_refund_phase
    ;;
  cleanup)
    run_cleanup_phase
    ;;
esac

log "04-payment-drill PASS phase=$PAYMENT_DRILL_PHASE"
