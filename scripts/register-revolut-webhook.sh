#!/usr/bin/env bash
# Register (or re-register) the Revolut Merchant webhook and print its signing
# secret (T-B4). The response `signing_secret` is a `wsk_…` value — put it in the
# app's REVOLUT_WEBHOOK_SIGNING_SECRET so POST /api/webhooks/revolut can verify
# deliveries. Endpoint: POST {REVOLUT_API_BASE}/api/webhooks (GATE-verified).
#
# Usage:
#   REVOLUT_API_SECRET_KEY=sk_… \
#   REVOLUT_API_BASE=https://sandbox-merchant.revolut.com \
#   WEBHOOK_URL=https://app.example.com/api/webhooks/revolut \
#   ./scripts/register-revolut-webhook.sh
set -euo pipefail
: "${REVOLUT_API_SECRET_KEY:?}" "${REVOLUT_API_BASE:?}" "${WEBHOOK_URL:?}"
curl -sS -X POST "$REVOLUT_API_BASE/api/webhooks" \
  -H "Authorization: Bearer $REVOLUT_API_SECRET_KEY" \
  -H "Revolut-Api-Version: ${REVOLUT_API_VERSION:-2026-04-20}" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK_URL\",\"events\":[\"ORDER_COMPLETED\",\"ORDER_AUTHORISED\",\"ORDER_PAYMENT_FAILED\",\"ORDER_PAYMENT_DECLINED\",\"ORDER_CANCELLED\"]}" \
  | jq -r '.signing_secret'
