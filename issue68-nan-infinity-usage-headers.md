# issue 68 — `NaN`/`Infinity` in usage headers: **[CORRECTED 2026-10-23] not reachable end-to-end; downgrade to hardening**

> ## STATUS UPDATE (2026-10-23, before upstream reporting — self-correction)
>
> While preparing the recording, I re-verified the full chain at current `main` (`279dd5e2`) — including an empirical run of the repo's exact zod version (`4.5.4`). **The impact claims below are NOT reachable end-to-end today.** Three independent layers block them:
>
> 1. **No non-finite number can be delivered by a community endpoint.** JSON cannot encode `NaN`, and zod **4.5.4 rejects `NaN` and `Infinity` on every number validator by default** (`z.number()`, `.int()`, `.positive()` — a zod v4 behavior change; verified empirically). Every body-usage path is gated by such a validator (`CompletionUsageSchema` for chat non-stream and the stream terminal chunk, `CommunityVideoUsageSchema` for video duration) or by `isTokenCount()` (`Number.isSafeInteger`) / `Number.isFinite` (embeddings, image tokens, transcription duration).
> 2. **Community endpoints' raw response headers never reach billing.** gen rebuilds all `x-usage-*` headers itself from the parsed body (`text/handler.ts usageHeaders()`, `image/utils/trackingHeaders.ts buildTrackingHeaders()`, `embeddings/communityEndpoint.ts embeddingResponse()`), and `buildUsageHeaders()` drops `NaN` values anyway (`value > 0` is false for `NaN`, `usage-headers.ts:443`). So the "reply with `x-usage-prompt-text-tokens: NaN`" attack vector described below does not exist: `parseUsageHeaders` only ever parses gen-built headers.
> 3. **Non-finite totals throw before any SQL.** `roundPollenLedgerAmount` (`shared/billing/precision.ts`) throws `RangeError("Pollen ledger amount must be finite")` on NaN/±Infinity, and `computeBilledPrice()` re-rounds the final billed amount — so the "SQLite binds NaN as NULL → wallet wipe" and "0.75 × Infinity owner credit" chains abort inside `handleBalanceDeduction` (caught by track.ts's billing-failure handler) before the ledger. The observable effect of a non-finite usage is only a **silently-skipped charge** (free generation, no analytics row).
>
> ### What stands (hardening / defense-in-depth)
>
> - `parseUsageHeaders` (`shared/registry/usage-headers.ts:455-474`) does a bare `Number(value)` with no `Number.isFinite`, while the provider-billing headers on the *same response* ARE finite-validated (`track.ts:1355-1366`). One-line fix: mirror that validation. The value of the fix is regression safety — any future code path that forwards an endpoint-controlled header string into `x-usage-*` (or a new modality whose body validator lacks a finite check) would re-open the ledger-write chains described below.
> - **New nit found during this re-verification:** `roundPollenLedgerAmount` validates only its *input*; `amount × 10^8` overflows to `Infinity` for inputs ≥ ~1.8e300, so the function can **return** non-finite from finite input (violating its "must be finite" contract). Downstream this is caught by `computeBilledPrice` (charge skipped), but the post-rounding result should be re-checked.
> - The practically exploitable billing-forgery class remains the unbounded **finite** self-report of **issue 58** — e.g. video `usage.duration` is accepted by `z.number().positive()` with no upper bound (`1e290` → caller wallet `-5e287`, owner credit `3.75e287`, because the pack branch of `atomicDeductUserBalance` has no sufficiency check). If a severity story is needed, 58 is the live one.
>
> Recommended reporting stance: downgrade this issue to hardening/defense-in-depth (low), reference it from issue 58 as "the non-finite flavor of the same ingestion point, currently shielded by zod v4 + the ledger precision guard". A 90-second unit-level PoC (parser accepts `"NaN"`/`"1e999"`; zod 4.5.4 rejects them; ledger guard throws) is in `download/poc-issue68/`.
>
> ---
> The original (now partially incorrect) analysis follows for the record.

**Severity: corrected from high → low (hardening). Original claim: victim-side wallet destruction + self-enrichment via NaN/Infinity usage headers.**
**Status: unit-verified parser gap; end-to-end impact blocked by zod 4.5.4 default-finite validation + gen-rebuilt headers + ledger finite guard (see STATUS UPDATE above)**

## Summary

Every self-reported usage number that reaches billing passes through `parseUsageHeaders`, which does a plain `Number(value)` with **no finiteness check**:

- `shared/registry/usage-headers.ts:455-474` — `parseUsageHeaders` builds the `Usage` object with `usage[usageType] = Number(value)` for every `x-usage-*` header. `Number("NaN")` → `NaN`; `Number("1e999")` → `Infinity`. Neither is rejected.
- `gen.pollinations.ai/src/middleware/track.ts:1355-1366` — by contrast, the **provider-billing** headers (`x-usage-provider-billable-units`, `x-usage-provider-unit-cost`) *are* strictly validated (`Number.isFinite`, `> 0`) before use. The token/seconds/units headers on the same response are not.
- The values come from the community endpoint's response headers, which the community server chooses freely (issue 58 / issue 67 territory: `gen.pollinations.ai/src/text/handler.ts` `usageHeaders()` passes the endpoint's self-report through; embeddings do the same via `buildUsageHeaders`).

*(Correction: the third bullet is inaccurate — gen rebuilds those headers from the parsed body; see STATUS UPDATE. The parser gap itself is real.)*

Why non-finite numbers are not caught downstream — every guard uses `<=`/`>` comparisons, which are **false** for `NaN`:

- `shared/billing/deduction.ts:47-55` — `atomicDeductUserBalance` returns early only when `amount <= 0`; `NaN <= 0` is `false`, so the UPDATE runs with a NaN parameter.
- `shared/billing/deduction.ts:163` — `atomicCreditUserBalance` guard `amount <= 0` — same bypass.
- `shared/billing/deduction.ts:140-147` — `atomicAdjustApiKeyBalance` guard is `amount === 0` only.
- `shared/billing/precision.ts` / `roundPollenLedgerAmount` — `Math.round(NaN)` stays `NaN`.

*(Correction: `roundPollenLedgerAmount` throws on non-finite input before any of these are reached; see STATUS UPDATE. The deduction-helper fail-closed recommendation below remains valid defense-in-depth.)*

SQLite (D1) **binds NaN doubles as NULL** and propagates them through arithmetic, so each write lands differently:

1. **Victim wallet wipe (NULL balances).** `atomicDeductUserBalance(db, victim, NaN)` executes `SET tier_balance = ROUND(COALESCE(tier_balance,0) - <NULL>, 8)` → **NULL** (and the same for `pack_balance` when that bucket is selected). `getUserBalance` (`shared/billing/balance.ts:28-31`) reads `user?.tierBalance ?? 0` — the account's balance is now indistinguishable from **zero**, and `getAvailableBalance` reports 0. The pollen the victim had is not moved to the attacker — it is *destroyed* (griefing-grade wallet wipe; `COALESCE(…,0)` keeps future deductions working, so the account is silently zeroed rather than bricked).
2. **Key budget becomes NULL = unlimited (attacker-side, self-service).** `reconcileApiKeyBalance` (`shared/billing/track-helpers.ts:484-499`) computes `adjustment = billedAmount - reservedAmount` = NaN and calls `atomicAdjustApiKeyBalance` → `SET pollen_balance = ROUND(pollen_balance - <NULL>, 8)` → **NULL**. `hasApiKeyBudget` (`track-helpers.ts:478-482`) explicitly treats a non-number as "no budget", and `atomicReserveApiKeyBalance` only ever enforces budgets when `pollen_balance IS NOT NULL` (`deduction.ts:119-125`) — a nulled budget is the **unlimited** convention.
3. **Infinite community-owner credit.** With `Infinity` instead of NaN (`x-usage-prompt-text-tokens: 1e999`), `totalPrice` is `Infinity`, the caller's balance becomes `-Infinity` (see 1), and `creditCommunityOwner` (`shared/billing/track-helpers.ts:446-476`) runs `atomicCreditUserBalance(owner, bucket, 0.75 × Infinity)` → `ROUND(COALESCE(pack_balance,0) + <Inf>, 8)` → the attacker's own balance is **+Infinity** — permanently unlimited pollen, in one request.

*(Correction: chains 1-3 are blocked by layers 1-3 in the STATUS UPDATE; retained as the hazard analysis showing why the ingestion point should validate.)*

## Attack (as originally hypothesized — not reachable, see STATUS UPDATE)

Attacker = owner of a public community model/agent endpoint (same publication gate as issue 58) — or any future code path that lets a caller influence an `x-usage-*` header string:

```
# victim calls the attacker's community model once
POST /v1/chat/completions {"model":"community/<attacker>/<model>","messages":[…]}
# attacker's endpoint replies 200 with:
x-usage-prompt-text-tokens: NaN
```

## Fix (minimal) — unchanged, still recommended

One line of validation at the shared ingestion point, plus defense in depth:

- `shared/registry/usage-headers.ts:455-474` (`parseUsageHeaders`): reject non-finite / non-safe-integer values, e.g. `const n = Number(value); if (!Number.isFinite(n) || n < 0) continue;` (or throw, to surface a misbehaving endpoint the way `extractUsageHeaders` already throws for invalid provider receipts at `track.ts:1357-1364`).
- `shared/billing/precision.ts` (`roundPollenLedgerAmount`): re-check finiteness **after** rounding (`amount × 10^8` overflows to `Infinity` for inputs ≥ ~1.8e300 — currently returns non-finite from finite input).
- Defense in depth: make `atomicDeductUserBalance` / `atomicCreditUserBalance` / `atomicAdjustApiKeyBalance` (`shared/billing/deduction.ts`) fail closed on non-finite `amount` (`if (!Number.isFinite(amount) || amount <= 0 …)`), so no future caller can NULL a balance or budget column by reaching these helpers with NaN.

Cross-references: issue 58 (unbounded community usage — magnitude; the live exploitable class), issue 67 (embeddings route — same ingestion point), issue 50 (the apikey-budget reconcile helper being reused here).
