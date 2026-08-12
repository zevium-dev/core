#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-zevium-payment-drill}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cleanup() {
  close_browser
}
trap cleanup EXIT

: "${STRIPE_SECRET_KEY:?STRIPE_SECRET_KEY is required}"

step "sign in to stable staging"
wait_for_url "$E2E_BASE_URL/" "200" 90
sign_in

step "start Stripe Checkout"
open_path "/app/billing"
ab wait --text "Buy credits" >/dev/null
if ! ab find text 'Buy $10.00' click --exact >/dev/null 2>&1; then
  ab find role button click --name 'Buy $10.00' >/dev/null
fi
ab wait --url "https://checkout.stripe.com/**" >/dev/null

step "complete Stripe sandbox card payment"
ab fill 'input[name="cardNumber"]' "4242424242424242"
ab fill 'input[name="cardExpiry"]' "1234"
ab fill 'input[name="cardCvc"]' "123"
if ab get count 'input[name="billingName"]' | grep -qv '^0$'; then
  ab fill 'input[name="billingName"]' "Zevium CI"
fi
if ab get count 'input[name="billingPostalCode"]' | grep -qv '^0$'; then
  ab fill 'input[name="billingPostalCode"]' "10001"
fi
ab find role button click --name "Pay" >/dev/null
ab wait --url "**/app/billing?checkout=*" >/dev/null

billing_url="$(ab get url)"
checkout_id="$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("checkout") || "")' "$billing_url")"
[[ "$checkout_id" == cs_* ]] || fail "checkout return URL lacks Stripe session id"
ab wait --text "Confirmed" >/dev/null

step "refund Stripe sandbox payment"
session_json="$E2E_ARTIFACTS/checkout-session.json"
refund_json="$E2E_ARTIFACTS/refund.json"
curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" "https://api.stripe.com/v1/checkout/sessions/$checkout_id" >"$session_json"
payment_intent="$(node -e 'const x=require(process.argv[1]); console.log(x.payment_intent || "")' "$session_json")"
[[ "$payment_intent" == pi_* ]] || fail "checkout session lacks payment intent"
curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" -X POST https://api.stripe.com/v1/refunds \
  --data-urlencode "payment_intent=$payment_intent" \
  --data-urlencode "metadata[zevium_drill]=true" >"$refund_json"
refund_status="$(node -e 'const x=require(process.argv[1]); console.log(x.status || "")' "$refund_json")"
assert_eq "$refund_status" "succeeded" "Stripe refund did not succeed"

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
