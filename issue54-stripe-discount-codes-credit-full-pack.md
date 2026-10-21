# Discounted Stripe checkouts credit full pack pollen — the "was actually paid" guard checks the pre-discount subtotal

## Summary

Pack checkout sessions are created with `allow_promotion_codes: true` (`enter.pollinations.ai/src/routes/stripe.ts:425`), and the webhook's only amount check gates on **`amount_subtotal` — which by Stripe semantics excludes discounts** (`enter.pollinations.ai/src/routes/stripe-webhooks.ts:475-487`):

```ts
// Localized presentment subtotal (Adaptive Pricing), used only to confirm
// the session was actually paid — never as a credit source. ...
const presentmentSubtotal = Math.round(
    (session.amount_subtotal || 0) / 100,
);
...
if (presentmentSubtotal <= 0) {
    console.error("Invalid payment amount:", session.amount_total);
    return { success: false, message: "Invalid payment amount" };
}
```

The credit itself is `pack.amountUsd` regardless of what was charged (`stripe-webhooks.ts:524-530` via `creditCheckoutSessionOnce`).

With a **100%-off promotion code** (checkout accepts any code in the Stripe account — there is no per-code allowlist in code), Stripe fires `checkout.session.completed` with `payment_status: "paid"`, `amount_total = 0`, but `amount_subtotal = 10000` (pre-discount). `presentmentSubtotal = Math.round(10000/100) = 100 > 0` → the guard **passes** (verified numerically), `payment_status === "paid"` is satisfied by a fully-discounted session (`stripe-webhooks.ts:652`) — and the webhook credits **100 pollen for $0 paid**.

## Attack

1. A promotion code exists in the Stripe account (created by any operator/marketer for any legitimate campaign).
2. `POST /api/stripe/checkout/p100/session` → pay at Stripe Checkout applying the discount code.
3. Webhook credits the full 100 pollen; the payer paid $0 (or any discounted amount — a 50%-off code still credits the full pack).

Operator-gated (requires a discount code to exist), but it breaks the charged-vs-credited invariant the guard exists to enforce.

## Fix (minimal)

Gate on the post-dispatch total instead: `if ((session.amount_total ?? 0) <= 0) return { success: false, ... }` in `handleCheckoutSessionCompleted` (keep `amount_subtotal` out of the decision), or reject when `session.total_details?.amount_discount` is non-zero. Add a test with a fully-discounted session fixture.

Related policy gaps observed in the same file (lower severity, worth deciding explicitly): `refund.created/updated/failed` handlers are Tinybird-analytics only (`stripe-webhooks.ts:815-839`) — refunds never reverse `pack_balance`, the `stripe_checkout_credits` ledger, or the top-up quest rewards (`+5`/`+50` pollen tiers at `src/services/quests/groups/account-setup.ts:110-137`), so buy → earn quest pollen → refund keeps both.
