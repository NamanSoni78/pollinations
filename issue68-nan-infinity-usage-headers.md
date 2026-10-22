# issue 68 — `NaN`/`Infinity` in self-reported usage headers: victim balances get **NULLed (wallet wipe)**, key budgets become **NULL = unlimited**, and the community-owner credit can become **Infinity**

**Severity: high (victim-side wallet destruction + self-enrichment; a distinct failure mode of the issue-58 trust hole with a distinct fix location)**
**Status: code-verified on production commit 4a6cd83f; the shared parsing code is the same one live-verified via issue 67's caller-side charge**

## Summary

Every self-reported usage number that reaches billing passes through `parseUsageHeaders`, which does a plain `Number(value)` with **no finiteness check**:

- `shared/registry/usage-headers.ts:455-474` — `parseUsageHeaders` builds the `Usage` object with `usage[usageType] = Number(value)` for every `x-usage-*` header. `Number("NaN")` → `NaN`; `Number("1e999")` → `Infinity`. Neither is rejected.
- `gen.pollinations.ai/src/middleware/track.ts:1355-1366` — by contrast, the **provider-billing** headers (`x-usage-provider-billable-units`, `x-usage-provider-unit-cost`) *are* strictly validated (`Number.isFinite`, `> 0`) before use. The token/seconds/units headers on the same response are not.
- The values come from the community endpoint's response headers, which the community server chooses freely (issue 58 / issue 67 territory: `gen.pollinations.ai/src/text/handler.ts` `usageHeaders()` passes the endpoint's self-report through; embeddings do the same via `buildUsageHeaders`).

Why non-finite numbers are not caught downstream — every guard uses `<=`/`>` comparisons, which are **false** for `NaN`:

- `shared/billing/deduction.ts:47-55` — `atomicDeductUserBalance` returns early only when `amount <= 0`; `NaN <= 0` is `false`, so the UPDATE runs with a NaN parameter.
- `shared/billing/deduction.ts:163` — `atomicCreditUserBalance` guard `amount <= 0` — same bypass.
- `shared/billing/deduction.ts:140-147` — `atomicAdjustApiKeyBalance` guard is `amount === 0` only.
- `shared/billing/precision.ts` / `roundPollenLedgerAmount` — `Math.round(NaN)` stays `NaN`.

SQLite (D1) **binds NaN doubles as NULL** and propagates them through arithmetic, so each write lands differently:

1. **Victim wallet wipe (NULL balances).** `atomicDeductUserBalance(db, victim, NaN)` executes `SET tier_balance = ROUND(COALESCE(tier_balance,0) - <NULL>, 8)` → **NULL** (and the same for `pack_balance` when that bucket is selected). `getUserBalance` (`shared/billing/balance.ts:28-31`) reads `user?.tierBalance ?? 0` — the account's balance is now indistinguishable from **zero**, and `getAvailableBalance` reports 0. The pollen the victim had is not moved to the attacker — it is *destroyed* (griefing-grade wallet wipe; `COALESCE(…,0)` keeps future deductions working, so the account is silently zeroed rather than bricked).
2. **Key budget becomes NULL = unlimited (attacker-side, self-service).** `reconcileApiKeyBalance` (`shared/billing/track-helpers.ts:484-499`) computes `adjustment = billedAmount - reservedAmount` = NaN and calls `atomicAdjustApiKeyBalance` → `SET pollen_balance = ROUND(pollen_balance - <NULL>, 8)` → **NULL**. `hasApiKeyBudget` (`track-helpers.ts:478-482`) explicitly treats a non-number as "no budget", and `atomicReserveApiKeyBalance` only ever enforces budgets when `pollen_balance IS NOT NULL` (`deduction.ts:119-125`) — a nulled budget is the **unlimited** convention. (The attacker NULLs their own user balance in the same request, so this is mainly interesting as the mechanism, e.g. against a key that still has account-side funding paths.)
3. **Infinite community-owner credit.** With `Infinity` instead of NaN (`x-usage-prompt-text-tokens: 1e999`), `totalPrice` is `Infinity`, the caller's balance becomes `-Infinity` (see 1), and `creditCommunityOwner` (`shared/billing/track-helpers.ts:446-476`) runs `atomicCreditUserBalance(owner, bucket, 0.75 × Infinity)` → `ROUND(COALESCE(pack_balance,0) + <Inf>, 8)` → the attacker's own balance is **+Infinity** — permanently unlimited pollen, in one request.

The NaN form requires no price manipulation and no large numbers — a single header value `NaN` is enough.

## Attack

Attacker = owner of a public community model/agent endpoint (same publication gate as issue 58) — or any future code path that lets a caller influence an `x-usage-*` header string:

```
# victim calls the attacker's community model once
POST /v1/chat/completions {"model":"community/<attacker>/<model>","messages":[…]}
# attacker's endpoint replies 200 with:
x-usage-prompt-text-tokens: NaN
```

- **Against a victim caller:** their tier/pack balance is NULLed → reads as 0 in the dashboard and in `getAvailableBalance`; their preflight (`requireFunds`) starts failing with no purchase history to explain it. Balance destruction is silent — no error surfaces to the victim.
- **Against the attacker's own account (Infinity variant):** `x-usage-prompt-text-tokens: 1e999` once → attacker's owner reward credit is `+Infinity` → unlimited pollen forever (their own caller-side balance goes `-Infinity`, which also reads as 0 — the attacker can re-fund the account through the now-infinite reward bucket or repeat the trick with a second account as the caller).

## Fix (minimal)

One line of validation at the shared ingestion point, plus one at the body-parser used by embeddings:

- `shared/registry/usage-headers.ts:455-474` (`parseUsageHeaders`): reject non-finite / non-safe-integer values, e.g. `const n = Number(value); if (!Number.isFinite(n) || n < 0) continue;` (or throw, to surface a misbehaving endpoint the way `extractUsageHeaders` already throws for invalid provider receipts at `track.ts:1357-1364`).
- `shared/registry/usage-headers.ts:351-355` (`isTokenCount`): require `Number.isFinite` and an upper bound (shared with the issue 58/67 cap).
- Defense in depth: make `atomicDeductUserBalance` / `atomicCreditUserBalance` / `atomicAdjustApiKeyBalance` (`shared/billing/deduction.ts`) fail closed on non-finite `amount` (`if (!Number.isFinite(amount) || amount <= 0 …)`), so no future caller can NULL a balance or budget column by reaching these helpers with NaN.

Cross-references: issue 58 (unbounded community usage — magnitude), issue 67 (embeddings route — same ingestion point), issue 50 (the apikey-budget reconcile helper being reused here).
