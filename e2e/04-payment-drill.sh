#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_SESSION="${E2E_SESSION:-${E2E_SESSION_PREFIX:-zevium-e2e}-payment-signed-in}"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

checkout_id=""
drill_refunded=false

refund_failed_checkout() {
  [[ "$checkout_id" == cs_* ]] || return 0
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
      -H "Idempotency-Key: zevium-drill-cleanup-$checkout_id" \
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
    refund_failed_checkout
  fi
  close_browser
  cleanup_e2e_runtime
}
trap cleanup EXIT

: "${STRIPE_SECRET_KEY:?STRIPE_SECRET_KEY is required}"
configure_browser_context

step "sign in to stable staging"
wait_for_url "$E2E_BASE_URL/" "200" 90
verify_target_commit "payment"
sign_in

step "start Stripe Checkout"
open_path "/app/billing"
ab wait --text "Buy credits" >/dev/null
if ! ab find text "Buy $10.00" click --exact >/dev/null 2>&1; then
  ab find role button click --name "Buy $10.00" >/dev/null
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
proof_stamp="$(date +%Y%m%d-%H%M%S)-$(date +%N)"
session_json="$E2E_RAW_DIR/$proof_stamp-checkout-session.raw.json"
refund_json="$E2E_RAW_DIR/$proof_stamp-refund.raw.json"
curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" "https://api.stripe.com/v1/checkout/sessions/$checkout_id" >"$session_json"
payment_intent="$(node -e 'const x=require(process.argv[1]); console.log(x.payment_intent || "")' "$session_json")"
[[ "$payment_intent" == pi_* ]] || fail "checkout session lacks payment intent"
sanitize_artifact "$session_json" "$E2E_ARTIFACTS/$proof_stamp-checkout-proof.json" "stripe-session"
curl -fsS --oauth2-bearer "$STRIPE_SECRET_KEY" -X POST \
  -H "Idempotency-Key: zevium-drill-$checkout_id" \
  https://api.stripe.com/v1/refunds \
  --data-urlencode "payment_intent=$payment_intent" \
  --data-urlencode "metadata[zevium_drill]=true" >"$refund_json"
refund_status="$(node -e 'const x=require(process.argv[1]); console.log(x.status || "")' "$refund_json")"
assert_eq "$refund_status" "succeeded" "Stripe refund did not succeed"
drill_refunded=true
sanitize_artifact "$refund_json" "$E2E_ARTIFACTS/$proof_stamp-refund-proof.json" "stripe-refund"

step "verify refund reached Zevium"
for _ in $(seq 1 30); do
  open_path "/app/billing"
  snap="$(page_text)"
  if [[ "$snap" == *"Refunded"* ]]; then
    record_browser_contract "payment" "checkout-refund-history" "signed-in"
    if [[ "${E2E_RUNNER_ACTIVE:-0}" != "1" ]]; then
      for excluded_lane in preview auth publisher consumer paid-consumer; do
        record_manifest_result "$excluded_lane" "excluded" 0 "standalone payment drill did not request this lane"
      done
      record_manifest_result "payment" "passed" 0 "real checkout, fulfillment, refund, and webhook history asserted"
      build_evidence_manifest "$E2E_ARTIFACTS/$proof_stamp-payment-evidence-manifest.json"
    fi
    log "04-payment-drill PASS"
    exit 0
  fi
  sleep 2
done
fail "refund webhook did not reach billing history within 60 seconds"
