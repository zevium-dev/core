#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-zevium-payment-drill}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

checkout_id=""
drill_refunded=false

refund_failed_checkout() {
  [[ "$checkout_id" == cs_test_* ]] || return 0

  local session_json payment_status payment_intent refund_json refund_status
  session_json="$(
    curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" \
      "https://api.stripe.com/v1/checkout/sessions/$checkout_id"
  )" || return 0
  payment_status="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.payment_status || "")' "$session_json")"
  [[ "$payment_status" == "paid" ]] || return 0
  payment_intent="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.payment_intent || "")' "$session_json")"
  [[ "$payment_intent" == pi_* ]] || return 0

  refund_json="$(
    curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" -X POST \
      -H "Idempotency-Key: zevium-drill-$checkout_id" \
      https://api.stripe.com/v1/refunds \
      --data-urlencode "payment_intent=$payment_intent" \
      --data-urlencode "metadata[zevium_drill]=true"
  )" || return 0
  refund_status="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.status || "")' "$refund_json")"
  [[ "$refund_status" == "succeeded" ]] && log "cleanup refunded failed drill checkout"
}

cleanup() {
  local code="$?"
  if (( code != 0 )) && [[ "$drill_refunded" != true ]]; then
    refund_failed_checkout || true
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

step "sign in to stable staging"
wait_for_url "$E2E_BASE_URL/" "200" 90
ab open "$E2E_BASE_URL/" >/dev/null
ab cookies clear >/dev/null
sign_in

step "start Stripe Checkout"
open_path "/app/billing"
ab wait --text "Buy credits" >/dev/null
ab find role button click --name 'Buy $10.00' >/dev/null
wait_for_url_pattern "https://checkout.stripe.com/" 30
ab wait --load domcontentloaded >/dev/null 2>&1 || true
wait_for_text "Payment method" 30
checkout_url="$(ab get url)"
checkout_id="$(node -e 'const match=new URL(process.argv[1]).pathname.match(/cs_test_[A-Za-z0-9]+/); console.log(match?.[0] || "")' "$checkout_url")"
[[ "$checkout_id" == cs_test_* ]] || fail "Stripe sandbox URL lacks checkout session id"

step "complete Stripe sandbox card payment"
if ab get count 'input[name="email"]' | grep -qv '^0$'; then
  log "fill checkout email"
  ab fill 'input[name="email"]' "$E2E_EMAIL"
fi
if ab get count 'input[name="cardNumber"]' | grep -q '^0$'; then
  log "select card payment method"
  ab find role button click --name "Pay with card" >/dev/null
  ab wait 'input[name="cardNumber"]' >/dev/null || fail "card fields did not open"
fi
log "fill card number"
ab fill 'input[name="cardNumber"]' "4242424242424242"
log "fill card expiry"
ab fill 'input[name="cardExpiry"]' "1234"
log "fill card CVC"
ab fill 'input[name="cardCvc"]' "123"
if ab get count 'input[name="billingName"]' | grep -qv '^0$'; then
  log "fill cardholder name"
  ab fill 'input[name="billingName"]' "Zevium CI"
fi
if ab get count 'input[name="billingPostalCode"]' | grep -qv '^0$'; then
  ab fill 'input[name="billingPostalCode"]' "10001"
fi
ab scroll down 700 >/dev/null
pay_ref="$(page_interactive | sed -nE 's/^[[:space:]]*- button "Pay" \[ref=([^],]+).*/\1/p' | head -1)"
[[ -n "$pay_ref" ]] || fail "Stripe Pay button is missing"
ab click "@$pay_ref" >/dev/null || fail "Stripe Pay button could not be clicked"
wait_for_url_pattern "/app/billing?checkout=" 60

billing_url="$(ab get url)"
returned_checkout_id="$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("checkout") || "")' "$billing_url")"
assert_eq "$returned_checkout_id" "$checkout_id" "checkout return URL changed Stripe session id"
wait_for_text "Confirmed" 90

step "refund Stripe sandbox payment"
session_json="$E2E_ARTIFACTS/checkout-session.json"
refund_json="$E2E_ARTIFACTS/refund.json"
curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" "https://api.stripe.com/v1/checkout/sessions/$checkout_id" >"$session_json"
payment_intent="$(node -e 'const x=require(process.argv[1]); console.log(x.payment_intent || "")' "$session_json")"
[[ "$payment_intent" == pi_* ]] || fail "checkout session lacks payment intent"
curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" -X POST https://api.stripe.com/v1/refunds \
  -H "Idempotency-Key: zevium-drill-$checkout_id" \
  --data-urlencode "payment_intent=$payment_intent" \
  --data-urlencode "metadata[zevium_drill]=true" >"$refund_json"
refund_status="$(node -e 'const x=require(process.argv[1]); console.log(x.status || "")' "$refund_json")"
assert_eq "$refund_status" "succeeded" "Stripe refund did not succeed"
drill_refunded=true

step "verify refund reached Zevium"
for _ in $(seq 1 30); do
  open_path "/app/billing"
  snap="$(page_text)"
  if [[ "$snap" == *"Refunded"* ]]; then
    log "04-payment-drill PASS"
    exit 0
  fi
  sleep 2
done
fail "refund webhook did not reach billing history within 60 seconds"
