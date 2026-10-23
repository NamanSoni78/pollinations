# issue 72 — Stripe refunds and chargebacks never reverse credited Pollen: buy → spend → refund/chargeback keeps the Pollen (and the platform also eats Stripe's $15 dispute fee) — no reversal, no ban, no balance freeze anywhere

**Severity: high (direct financial loss: every refunded or charged-back payment permanently mints Pollen; attacker-only, zero victim interaction, repeatable per account/card; Pollen converts directly to GPU sandboxes and premium generation)**
**Status: LIVE in production (code-verified at upstream `a9c570bc`, 2026-10-23); class = the platform's #2 priority (Pollen integrity — "duplicate or edit Pollen")**

## Summary

When a pack purchase succeeds, Stripe's webhook credits the buyer's wallet — atomically and idempotently (`stripe_checkout_credits.session_id` is UNIQUE, so the credit happens exactly once). But **the reverse direction does not exist anywhere in the codebase**: when Stripe later reverses that money — via a merchant-issued refund or a cardholder chargeback (dispute) — **no code path deducts, freezes, or even notices the credited Pollen**:

```ts
// enter.pollinations.ai/src/routes/stripe-webhooks.ts:817-841
case "refund.created":
case "refund.updated":
case "refund.failed": {
    const refund = event.data.object as Stripe.Refund;
    console.log(`Refund ${event.type}: ${refund.id}`);
    c.executionCtx.waitUntil(
        sendStripeEventToTinybird(c.env, {        // ← analytics ONLY
            eventType: event.type,
            ...
            amountCents: refund.amount || 0,
            ...
        }),
    );
    break;
}
```

Chargebacks are worse: `charge.dispute.created` / `charge.dispute.closed` **are not in the event switch at all** — they fall through to:

```ts
// enter.pollinations.ai/src/routes/stripe-webhooks.ts:843-845
default:
    console.log(`Unhandled Stripe event type: ${event.type}`);
```

Verified by exhaustive search of the entire `enter.pollinations.ai/src` tree: there is **no** `refunds.create` usage, no reversal/clawback function, no pollen deduction keyed to refunds or disputes, and **no ban/suspend/freeze of the account** (`ban|suspend|freeze|isUserBanned` → zero matches in `stripe-webhooks.ts`). The platform tracks refunds in Tinybird analytics — they know refunds happen — but never act on the wallet.

The codebase proves this is an omission, not a design decision: the **invoice** failure paths (`invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`, `stripe-webhooks.ts:779-799`) all run `markAutoTopUpInvoiceFailed` (attempt marked failed, auto top-up disabled, invoice cleaned up — `utils/stripe-billing/auto-top-up.ts:433-485`), showing failure/reversal handling was deliberately built for one payment surface — just not for pack purchases or refunds of already-credited money.

## Where the credit happens (the half that works)

```ts
// enter.pollinations.ai/src/routes/stripe-webhooks.ts:205-264
async function creditCheckoutSessionOnce({ env, event, session, userId, creditsToAdd }) {
    const [, updateResult] = await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO stripe_checkout_credits (session_id, event_id, ...) VALUES (...)`,   // UNIQUE(session_id) → idempotent
        ),
        env.DB.prepare(
            `UPDATE user
             SET pack_balance = ROUND(COALESCE(pack_balance, 0) + ?, ...),
                 last_pack_pollen = ?, low_balance_notified_at = NULL
             WHERE id = ?`,
        ).bind(creditsToAdd, creditsToAdd, userId),
    ]);
    ...
}
```

Triggered by `checkout.session.completed` / `checkout.session.async_payment_succeeded` (`stripe-webhooks.ts:651-709`). The credited amount is the pack's fixed USD amount looked up server-side from `metadata.packKey` (`shared/pollen-packs.ts`: p2/p5/p10/p20/p50/p100, 1 pollen ≈ $1, max **$100 per purchase**). The same gap applies to auto top-up invoices: `creditAutoTopUpInvoice` (`auto-top-up.ts:334-431`) credits `pack_balance += amountUsd` on `invoice.paid` — and a refund of that invoice payment is likewise never reversed.

The credit itself is correctly built (atomic batch, UNIQUE guard, server-side pack lookup). **The bug is that the money's return trip was never implemented.**

## Attack (attacker-only; zero victim interaction; zero interaction with Pollinations staff in the chargeback variant)

1. Attacker creates a Pollinations account and buys a pack — e.g. **p100, $100** — with any card. `checkout.session.completed` fires → `pack_balance += 100` instantly.
2. Attacker **spends** the Pollen immediately on real, valuable compute (each step is a plain API call):
   - GPU sandboxes: `pollinations-azure-xl` at 8 vCPU / 16 GiB, billed at 25% of Azure rates (`gen.pollinations.ai/src/routes/e2b.ts:67-83`), kept running for hours via sandbox keeps (`POST /alpha/e2b/sandboxes/:id/timeout` with a long `timeout`);
   - premium text/image/audio generation at full API rates.
   (Spending is optional — unspent Pollen is equally permanent.)
3. Attacker reverses the $100 through either channel, both fully attacker-controlled:
   - **Chargeback**: file a dispute with the card issuer ("unauthorized charge" / "product not delivered"). Stripe pulls the money from Pollinations and adds a **$15 dispute fee** (Stripe's standard fee, charged win or lose unless the dispute is resolved in their favor). Pollinations' webhook receives `charge.dispute.created` → `console.log("Unhandled Stripe event type")`.
   - **Merchant refund**: email/Discord support "I bought the wrong pack / I was double-charged" and get a goodwill refund from the dashboard. `refund.created` fires → Tinybird analytics row → **`pack_balance` unchanged**.
4. Result per cycle: the attacker consumed (or still holds) **100 Pollen ≈ $100 of paid compute**, the platform lost the $100 payment (+ $15 fee on chargebacks), and **nothing marks, bans, or limits the account** — `charge.dispute.*` is unhandled, `refund.*` only logs, and no ban/suspend/freeze logic exists in the webhook.
5. Repeat with fresh accounts/cards. Each cycle is independent; there is no cumulative protection (no dispute counter, no velocity check, no automatic ban).

## Why this is the "duplicate Pollen" class, from the money side

The user-facing invariant is: *pack_balance is backed by money Pollinations actually received*. This bug breaks it — every refunded purchase becomes Pollen that exists with no backing. Concretely:

- Buy 100 pollen, chargeback, **keep 100 pollen** → the balance is now pure loss.
- Buy 100 pollen, convert to XL-sandbox GPU hours, chargeback → Pollinations pays Azure/E2B for compute that was never paid for, plus the dispute fee.
- Combined with existing chains: a leaked/stolen key with `machines` scope (issues 61/70/71) converts the victim's topped-up Pollen the same way — but this issue needs **no victim at all**: the attacker mints value from their own refunded payment.

## Evidence trail (all attacker-side / code-level)

| Fact | Location |
|---|---|
| Credit on checkout completion, `pack_balance += N`, UNIQUE(session_id) | `stripe-webhooks.ts:205-264`, `:651-709` |
| `refund.created/updated/failed` → Tinybird analytics only, no wallet action | `stripe-webhooks.ts:817-841` |
| `charge.dispute.*` absent from the switch → default `console.log` | `stripe-webhooks.ts:843-845` |
| No reversal/clawback/refund-deduction code anywhere | exhaustive `rg` over `enter.pollinations.ai/src` (incl. `utils/stripe-billing/*`): no `refunds.create`, no pollen deduction tied to refunds |
| No ban/suspend/freeze on refund or dispute | `rg "ban|suspend|freeze|isUserBanned"` in `stripe-webhooks.ts` → 0 matches |
| Failure handling EXISTS for invoices (proving the omission is a bug, not a policy) | `stripe-webhooks.ts:779-799` → `markAutoTopUpInvoiceFailed` (`auto-top-up.ts:433-485`) |
| Same gap on auto top-up credits | `creditAutoTopUpInvoice` (`auto-top-up.ts:334-431`) credits on `invoice.paid`; refunds of those payments are never reversed |
| Pack sizes (max $100/charge) | `shared/pollen-packs.ts` (p2…p100) |
| Webhook authenticity | Stripe signature-verified + `livemode`-checked (credit path only benefits from this; it also means test-mode events can't fake credits — the bug is about real, reversed money) |

## Recommended fix

1. **Handle `refund.created` / `refund.updated`** (act when `refund.status === "succeeded"`): deduct `min(refund.amount/100, current pack_balance)` from the user's wallet (their ledger already tolerates negative balances by design — `atomicDeductUserBalance`'s pack branch has no floor), and mark the corresponding `stripe_checkout_credits` / `stripe_auto_top_up_attempt` rows as refunded. Idempotency key: the refund id.
2. **Handle `charge.dispute.created`**: immediately set the account's ban flag (the `isUserBanned` check is already wired into every billing surface) and freeze further purchases; on `charge.dispute.closed` with `status: "lost"`, deduct the disputed amount; with `status: "won"`, unban and restore.
3. Ensure the Stripe webhook endpoint subscribes to `refund.*` and `charge.dispute.*` (the `refund.*` cases already exist in code, so those events are already being delivered — the dispute events arrive too, hitting `default`).
4. Optional velocity signal: count `stripe_checkout_credits` per payment-method fingerprint vs. refunds/disputes per user; block further credits from cards with prior disputes.
