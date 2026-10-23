# issue 74 — `linkFallbackEntries` enforces the paid-only balance-class rule **only for community models**: an official model that declares a paid-only fallback target links it with no check — one registry line away from "Quest Pollen pays for a paid-only model"

**Severity: medium as shipped (missing invariant / defense-in-depth — zero exploitable chains exist in today's catalog, verified exhaustively); escalates to critical the moment any official model's `fallbacks` array names a paid-only target, because admission, pricing, and settlement all stay keyed to the *primary* model while a paid-only model serves the request**

**Status: unit-verified invariant gap in current `main` (`a9c570bc`); not attacker-triggerable today (the catalog is the platform's own config). This is the "free primary → paid-only target" trap the codebase itself explicitly forbids for community models — enforced on one side, absent on the other.**

## Summary

Pollinations' own billing invariant for fallbacks is written down in the code:

```ts
// shared/community-endpoints.ts:500-509
/**
 * A fallback cannot require a balance bucket the caller was never required to
 * have for the primary model. A paid-only primary may fall back to either kind.
 */
export function isCommunityFallbackBalanceAllowed(
    primary: { paidOnly: boolean },
    target: { paidOnly?: boolean },
): boolean {
    return !target.paidOnly || primary.paidOnly;
}
```

"A fallback cannot require a balance bucket the caller was never required to have for the primary model." The reasoning is exactly the Quest-Pollen question: a caller who was admitted on a non-paid-only primary was never required to hold paid Pollen, so the request must never end up being served — and billed — as a paid-only model.

That guard runs in **one place only**: `linkFallbackEntries`, and only when the *primary is a community endpoint*. For official (non-community) models the loop links every declared target with **no balance-class check at all**:

```ts
// gen.pollinations.ai/src/fallback.ts:315-346 — linkFallbackEntries()
for (const targetId of declared) {
    const target = byIdOrAlias.get(targetId);
    if (!target || target === entry) continue;
    if (entry.communityEndpoint) {              // ← the ENTIRE guard block is
        // ... isUsableCommunityFallback(entry, target) →              conditional on
        //     staticFallbackRejection(...) →                          the primary
        //         isCommunityFallbackBalanceAllowed(primary, target)   being a
        //             !target.paidOnly || primary.paidOnly            COMMUNITY
        //             model!                                          endpoint
    }
    if (targets.some((linked) => linked.id === target.id)) continue;
    targets.push({ ...target, fallbackEntries: undefined });   // ← official chain:
}                                                              //    linked, unchecked
```

## Why the rest of the pipeline would not save it

The fallback loop runs *around the upstream call itself* — deliberately after admission:

```ts
// gen.pollinations.ai/src/fallback.ts:358-366 (withModelFallback doc)
 * Placed around the upstream call itself rather than around the request, so
 * authentication, balance and moderation run exactly once no matter how many
 * models are tried.
```

So with a free primary that falls back to a paid-only target, every stage keys off the **primary**:

1. **Admission** (`gen.pollinations.ai/src/utils/generation-access.ts:37`): `const isPaidOnly = model.definition.paidOnly` — the *requested* model's flag. `requireFunds` for a Quest-Pollen-only key zeroes the paid bucket (`refusals.ts:107-111`) and rejects paid-only models — but this model **is not paid-only**; a Quest key with any tier balance sails through.
2. **Serving**: the paid-only target executes the generation and its bytes are returned.
3. **Settlement** (`gen.pollinations.ai/src/middleware/track.ts:428`): `modelPaidOnly: c.var.model?.definition.paidOnly` — the *primary's* flag, `false`. The authoritative deduction ladder (`shared/billing/deduction.ts:63-73`) then runs:

```sql
CASE
    WHEN ${isPaidOnly ? 1 : 0} = 1 THEN 'pack'   -- false: skipped
    WHEN ${questPollenOnly ? 1 : 0} = 1 THEN 'tier'   -- → Quest Pollen pays
    ...
```

The caller is charged from the **tier (Quest Pollen) bucket** — and at the *quoted* price, which `calculateUsageBilling` also derives from the primary (`quotedBy = requestTracking.modelDefinition`), so the paid-only model's real rate never even appears on the invoice. Net effect if such a chain existed: **paid-only model output, paid with Quest Pollen, at the free model's price** — the exact class issue 70's subset rule and the `questPollenOnly` bucket logic exist to prevent.

## Proof (unit level, current `main`)

`gen.pollinations.ai/test/wave24-fallback-guard-gap.test.ts` (passes):

```
[official primary] fallbackEntries after link: [ 'paid/model' ]
  => CONFIRMED: official free -> paid-only chain is linked, no balance-class check
[community primary] staticFallbackRejection: accepts only Paid Pollen, which this model does not require
[settlement] primary's paidOnly=false => ladder never selects 'pack' for a quest-only key:
            paid-only output is billed to Quest Pollen.
```

The **identical target definition** is accepted when the primary is official and rejected — with the exact balance-class message — when the primary is a community endpoint. The only variable is which side of the `if (entry.communityEndpoint)` branch the primary lands on.

## Today's catalog is clean (exhaustively checked)

A full dump of every `fallbacks` declaration across `TEXT_SERVICES`, `IMAGE_SERVICES`, `AUDIO_SERVICES`, `EMBEDDING_SERVICES` and `MODEL3D_SERVICES` (103 chains, `scripts/wave24-fallback-audit.ts`) shows **zero** non-paidOnly → paid-only chains. Every current chain is a same-model *provider route* (ids like `x-ai/grok-4.6:xai`), which inherits the parent's `paidOnly` by construction (`merge-fallbacks.ts` routes clone every field except `provider`). So nothing is exploitable today — the issue is that **nothing enforces this stays true**, while the community path shows the authors know the rule and encoded it on the side they could reach.

The realistic trigger is ordinary maintenance: someone adds `"fallbacks": ["anthropic/claude-haiku-5.5"]` to a free text model during an outage (the natural instinct when a free provider 5xxes), and the Quest-Pollen bypass ships silently — no test fails, because no invariant is encoded anywhere for official chains.

## Recommended fix

Hoist the balance-class rule out of the community branch so it applies to every link, in `linkFallbackEntries`:

```ts
for (const targetId of declared) {
    const target = byIdOrAlias.get(targetId);
    if (!target || target === entry) continue;
    if (!entry.communityEndpoint) {
        // The same rule the community path enforces: a fallback may not
        // require a balance class the caller was never required to have.
        if (target.definition.paidOnly && !entry.definition.paidOnly) continue;
    }
    if (entry.communityEndpoint) {
        // ... existing community checks unchanged ...
    }
    ...
}
```

Optionally also assert the invariant at settlement (`track.ts:418-438`): when `finalCandidate` resolved to a definition with `paidOnly !== c.var.model.definition.paidOnly`, either re-price against the served definition or refuse — defense in depth for any future path that dodges the linker (e.g. runtime fallback injection).

## References

- The rule, in the authors' words: `shared/community-endpoints.ts:500-509`
- The one-sided enforcement: `gen.pollinations.ai/src/fallback.ts:329-339`
- Settlement keyed to the primary: `gen.pollinations.ai/src/middleware/track.ts:428`
- Quest-Pollen admission semantics: `gen.pollinations.ai/src/utils/refusals.ts:106-127`, tests at `gen.pollinations.ai/test/byop-markup.test.ts:374-396`
- The deduction ladder: `shared/billing/deduction.ts:34-109`
- Related (subset rule, same spirit): issue 70 — child-key permission/budget escalation, where `questPollenOnly` was the one grant already enforced on both endpoints
