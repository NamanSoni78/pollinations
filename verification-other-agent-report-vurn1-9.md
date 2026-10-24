# Verification Report — Second-Agent "VURN-1 … VURN-9" Findings

- **Report verified**: `some-other-nonconfirm-bugs-from-aiagent.zip` (9 markdown findings + PoC test log), authored by a different AI agent, dated 2026-10-23, shared by the bounty reporter 2026-10-24.
- **Verifier**: primary bounty agent (this repo's `issues_mds` branch maintainer).
- **Verification date**: 2026-10-24 (code audit against current `main` + live tests against `gen.pollinations.ai`).
- **Bottom line**: **8 of 9 findings are real behaviors but exact duplicates of our previously filed issue 73** (filed and live-verified before this report was produced). **1 finding (VURN-4) is a false positive**, and **1 sub-claim (VURN-7 "safety key collision") is incorrect**. **No new issue number is warranted; issue 73 gains a corroboration addendum (Addendum 3) instead.**

## Root-cause convergence

Every confirmed finding in their report reduces to one primitive already documented in
`issue73-shared-text-cache-preauth-unbilled-cross-user.md`:

```
generateCacheKey(request, bodyText?, partition?, requiredSafetyFeatures?)
  → key = SHA-256(method | pathname | sorted-non-auth-query | filtered-body | safety-parts)
  // no caller identity — and textCache/audioCache lookup is mounted BEFORE generationAccess/auth
```

`src/middleware/text-cache.ts` states the design outright: *"Checks cache before access/balance checks so cache hits can remain public"*. The platform's own route docs disclose: *"Identical requests may be answered from a shared cache, also for callers without an API key."* Issue 73 covers the security consequence set: keyless replay of paid output, cross-tenant poisoning, zero billing on HITs, no rate limit on HITs.

## Per-finding disposition

| Their ID | Claim | Verdict | Evidence (ours, independent) |
|---|---|---|---|
| VURN-1 | `GET /text/:prompt` keyless cache HIT | **REAL — duplicate of issue 73 core** | Re-verified live 2026-10-24: keyed request → `x-cache: MISS`; keyless replay of the same URL → `x-cache: HIT`, identical body md5 `7d9812c2a3b7ab75daf40549fca84d91`, same `x-cache-date: 2026-10-24T13:30:19.507Z`, no pollen debited on the HIT. |
| VURN-2 | `/image`, `/v1/images/*`, media cache | **REAL — duplicate** (issue 73 scope addendum: image/video/3D routes share the same pre-auth mounting, commit `93d4bd80`) | `mediaCache` lookup precedes `generationAccess` on the image routes; our earlier live tests confirmed keyless image HITs. |
| VURN-3 | `POST /v1/chat/completions` | **REAL — duplicate** (issue 73 core scope) | `textCache` mounted at `routes/proxy.ts:227` ahead of `generationAccess`/`apiKeyBudgetReservation`; route description itself documents the shared cache for keyless callers. |
| VURN-4 | `/v1/models` "cached listing leaks restricted models to anonymous" | **FALSE POSITIVE** | (a) No `X-Cache`/`Age` header on `GET /v1/models` live; (b) `src/middleware/text-cache.ts:29` — "Non-cacheable routes like /v1/models should NOT use this middleware"; no `textCache` in the models handler chain in `src/routes/proxy.ts`; (c) anonymous catalog (409 entries) is the intended public listing — `paid_only` metadata is pricing disclosure, not an access grant; (d) decisive test: the account-private community model (`community/07mrbeastofficial/asdf`, present on the authenticated listing of our test key's owner) is **absent from the anonymous list** — no cross-user catalog leak exists on this route. |
| VURN-5 | `POST /v1/embeddings` | **REAL — duplicate** (issue 73 addendum 1, commit `1a0f74e5`) | `textCache` mounted on the embeddings route (`routes/proxy.ts` embeddings chain, `textCache` at the position before `generationAccess`). |
| VURN-6 | `/v1/audio/*` | **REAL — duplicate** (issue 73 addenda 1-2, commits `1a0f74e5`, `91114ce1`) | Map already covers `POST /v1/audio/speech`, `POST /v1/audio/transcriptions` (textCache!), `/v1/audio/speech/with-timestamps` (textCache, not audioCache), `GET /audio/:text`. |
| VURN-7 | "cache key collision across safety features" | **Sub-claim INCORRECT; underlying shared-cache behavior = issue 73** | `generateCacheKey()` includes: `x-safe` header part, `safe` query/body param, `required-safety:<features>` part, and `SAFETY_CACHE_VERSION` salt — safety configuration is keyed. Their PoC compares two byte-identical requests (`?safety=on` twice), which is not a collision test. The "edge cache layer" framing adds nothing beyond the same shared-cache primitive. |
| VURN-8 | image "cache poisoning" via prompt manipulation | **REAL — duplicate** (issue 73's cross-tenant poisoning impact) | Same primitive: attacker-controlled MISS content becomes the HIT content for any other caller with the same key. |
| VURN-9 | rate-limit bypass via cache | **REAL — duplicate** (issue 73's "no rate limit on HITs" impact) | Cache HITs are served from storage before rate-limit/balance middleware executes. |

## Report-quality observations (for triage trust weighting)

1. **Fabricated code evidence.** Their quoted snippets do not exist in the repo: `generateCacheKey(request, safeHeader, requiredSafetyFeatures)` (wrong signature), `createTextCache()` (real: `createGenerationCache(textCacheAdapter)`), `src/routes/openai.ts` (no such file; models live in `src/routes/proxy.ts`), and a "models handler with `getModelsForUser(request.user)`" (fabricated). Their line numbers do not correspond to real code.
2. **Right conclusion, wrong evidence.** The behavioral claims for VURN-1/2/3/5/6/8/9 still reproduce live — because issue 73 is real. This makes the report *directionally useful but not independently evidential*; every claim required our own re-verification before acceptance.
3. **CVSS inflation.** All nine were stamped 9.1/8.6/8.7 Critical/High with identical vectors; the real aggregate severity of the single underlying primitive is what issue 73 already assesses (pre-auth replay + cross-tenant poisoning + billing circumvention on shared-cache surfaces).
4. **Test key hygiene.** Their report embeds a full `sk_` API key in plaintext throughout — that key should be treated as burned and rotated by the reporter.

## Issuemd alignment decision

- No new issue number assigned (nothing new beyond issue 73's already-documented scope).
- `issue73-shared-text-cache-preauth-unbilled-cross-user.md` gains **Addendum 3** recording the independent corroboration and the two non-reproducing sub-claims (models-listing, safety-key-collision), so future triage sees both agents' findings reconciled in one place.
- This file is committed alongside it as the audit trail of the cross-agent verification exercise.
