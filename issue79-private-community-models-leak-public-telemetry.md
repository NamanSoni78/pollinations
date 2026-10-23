# issue 79 — Private community models are publicly listed with full operational telemetry on `/models/status` and `/models/stats` (and through the public Tinybird pipes): the publisher allowlist conceals them from the catalog, but nothing filters them from the public health/stats surfaces — 392 never-published model IDs live-verified

**Severity: high (information disclosure that defeats the platform's own private-model concealment invariant at scale: 392 community model IDs that are hidden from the public catalog — 404 to anonymous retrieval, exactly as designed — are enumerated with traffic volumes, success/error counts, latency percentiles, distinct-caller counts, median pollen costs, per-request IDs and timestamps, and their fallback chains; attacker-side only: plain unauthenticated curl, zero interaction; pre-auth)**
**Status: LIVE — verified end-to-end against production 2026-10-24 (see "Live verification")**

## Summary

Publishing a community model to the public catalog is allowlist-gated: only accounts whose `githubId` appears in the hardcoded `COMMUNITY_MODEL_ALLOWED_GITHUB_IDS` list may set `visibility: "public"` (`shared/auth/github-id-list.ts:87-94`, enforced by `requireCommunityEndpointPublishAccess` on every create/PATCH in `enter.pollinations.ai/src/routes/community-endpoints.ts` and `requireAgentWriteAccess` in `agents.ts`). Everything else stays `private`, and the platform treats a private model's **existence** as confidential — the fallback validator explicitly "conceals" private rows so that they "look identical to a missing row" (`enter.pollinations.ai/src/routes/community-endpoints/fallbacks.ts:46-60`).

This issue documents that the **public operational-telemetry surfaces never got that memo**:

1. Every request to a private community model emits a `generation_event_v2` row whose `resolved_model_requested` is the model's full ID `community/<owner-github-username>/<model-name>`.
2. The public pipes `model_route_health`, `model_catalog_health`, `model_health_24h`, and `public_model_stats` aggregate those events **with no community-visibility filter** — the only community-related filter anywhere in them is `startsWith(model, 'community/')`, which selects *more* of them.
3. Those pipes are served to anyone, unauthenticated, by `GET https://gen.pollinations.ai/models/status` and `GET https://gen.pollinations.ai/models/stats` (`gen.pollinations.ai/src/routes/model-status.ts`), and are also directly queryable with the public Tinybird read token embedded in that same source file ("documented for client-side use in docs/public-stats.md").

The result: **anyone can enumerate private, never-approved community models — their names, their owners, and their operational fingerprints — without publisher access.** The publisher gate hides a model from the catalog but lists it on the public status and stats surfaces. Among the leaked IDs live private proxies of paid models (`community/AkshayCoder48/claude-opus-5`, `community/Catniti/claude-sonnet-4`, `community/CloudCompile/gpt-6-luna`) whose traffic patterns, error rates, and latencies fingerprint their upstreams.

## Evidence table

| Fact | Location |
|---|---|
| Publishing is allowlist-gated by hardcoded numeric GitHub IDs; models default `private` | `shared/auth/github-id-list.ts:1-94`; `shared/db/better-auth.ts:323-327` (`visibility ... default("private")`); `enter.pollinations.ai/src/routes/community-endpoints.ts:121-138` (`requireCommunityEndpointPublishAccess`), `:293-300` (`enforcePublishingAccess`), `:695`, `:1048` (call sites) |
| Private-model existence is confidential by design — "Private rows owned by someone else must look identical to a missing row" | `enter.pollinations.ai/src/routes/community-endpoints/fallbacks.ts:46-60` (`shouldConcealTarget`), used at `:69`, `:178` |
| Every generation emits a Tinybird event carrying `resolved_model_requested` for community models (no visibility field exists in the event schema at all) | `shared/schemas/generation-event.ts`; ingestion pipes under `enter.pollinations.ai/observability/` |
| `model_route_health` groups raw events by `resolved_model_requested` / `model_used` with **no visibility filter** — one rollup row per model plus **one row per execution route (primary + every fallback target)** | `enter.pollinations.ai/observability/endpoints/model_route_health.pipe` (whole file; `FROM generation_events_classified`, no community-visibility join) |
| `model_catalog_health` samples the latest 50 eligible final requests per community model — filter is `startsWith(model, 'community/')` only | `enter.pollinations.ai/observability/endpoints/model_catalog_health.pipe` |
| `model_health_hourly` stores the recent-50 sample as `(timestamp, request_id, response_status)` tuples | `enter.pollinations.ai/observability/materializations/model_health_hourly_mv.pipe` |
| `public_model_stats` computes per-model `request_count, success_count, priced_success_count, user_count (distinct callers), avg_cost_usd (median priced pollen), avg_response_ms, error_count` from raw events with **no visibility filter** | `enter.pollinations.ai/observability/endpoints/public_model_stats_refresh.pipe` (whole file), served by `public_model_stats.pipe` |
| The status/stats routes serve these pipes to anyone, and the Tinybird read token for direct pipe access is embedded in gen's public source and documented for client-side use | `gen.pollinations.ai/src/routes/model-status.ts:9-10` (`MODEL_ROUTE_HEALTH_URL` incl. token), `:43-140` (`GET /models/status`, `GET /models/stats`); `gen.pollinations.ai/src/docs/public-stats.md` |
| Live: models that 404 to anonymous retrieval appear in the pipes with traffic | "Live verification" below |

## Attack (attacker-only, unauthenticated, one request)

1. `curl -s "https://gen.pollinations.ai/models/status?minutes=10080"` — the unauthenticated status surface. Filter for `community/` model IDs.
2. Diff against the anonymous catalog: `curl -s "https://gen.pollinations.ai/models?community=true&reliability=all"`. Every ID present in (1) but absent from (2) is a private (or otherwise non-listed) community model.
3. For each such ID the attacker now holds: the owner's **GitHub username**, the **model name**, request counts, 2xx/4xx/5xx splits, **p50/p95/avg latencies**, `last_request_at`, the top provider tag, and — at the route grain — **the model's private fallback chain** (one row per fallback target it ever fell through to).
4. `curl -s "https://gen.pollinations.ai/models/stats"` adds **distinct-caller counts and median priced pollen cost** per leaked model (once it crossed the 3-success/2-caller bar).
5. Optional, same data at higher fidelity: query the pipes directly through the Tinybird endpoint with the public token from gen's source — `model_catalog_health` returns the recent-50 `(timestamp, request_id, status)` sample per community model.
6. No publisher access, no account, no key, no interaction with any victim: the leak is the surface itself.

Secondary harms worth naming: (a) private models proxying paid upstreams (`claude-opus-5`, `gpt-6-luna`, …) have their upstream fingerprinted by latency/error/latency patterns — useful to a competitor or an attacker hunting for mispriced or abusable endpoints; (b) request volumes and caller counts of never-published models are marketplace-competitive intelligence; (c) the `request_id`s in the recent-50 sample are correlatable with other logs if any other surface ever exposes them; (d) the enumeration defeats the "missing row" concealment that `shouldConcealTarget` exists to provide — a private model's name can now be *confirmed* to exist, which the fallback validator deliberately avoids revealing.

## Live verification (2026-10-24)

- `GET https://gen.pollinations.ai/models/status?minutes=10080` (no auth): **726 distinct `community/…` model IDs** in the 7-day window.
- `GET https://gen.pollinations.ai/models?community=true&reliability=all` (anonymous view): **335** public community IDs.
- **392 IDs appear in the status surface but are not in the anonymous catalog.** Sampled five and confirmed the private-model signature on every one — anonymous `GET /models/<id>` returns **404** ("not accessible to the caller") while the same ID's pipe rows show live traffic, e.g.:
  - `community/ATTRAZION/team-scribe` — retrieve 404; pipe: `requests=1, 2xx=1, p50=5845ms, last=2026-10-19 12:33:37, provider=community`
  - `community/AkshayCoder48/claude-opus-5` — retrieve 404; pipe: `requests=20, 5xx=1, last=2026-10-23 12:14:51`
  - `community/Catniti/claude-sonnet-4`, `community/CloudCompile/animagine-xl`, `community/CloudCompile/app-icon-diffusion` — all retrieve 404 with non-zero pipe traffic.
- `GET https://gen.pollinations.ai/models/stats` (no auth): 230 community IDs, **50 not in the public catalog**, each with `request_count`, `user_count` (distinct callers), and `avg_cost_usd`.
- Direct Tinybird with the embedded public token: `model_catalog_health.json` → **704 community rows** (recent-50 samples, private included); `model_route_health.json?minutes=10080` → the same 726 IDs.
- Scripts: `/home/z/my-project/scripts/poc-issue79-private-models-leak.sh` (the diff) and `poc-issue79-verify.py` (the five-model concealment proof + stats diff). Runbook: `download/poc-issue79/LIVE-POC-STEPS-issue79.md`.

## Fix (minimal)

1. Filter private community models out of every public pipe (and the gen routes that proxy them). The pipe layer cannot see D1 visibility, so either (a) filter at the consumer: `filterCatalogEntries`/the status route joins the community catalog and drops IDs whose `communityEndpoint.visibility !== "public"`; or (b) tag the event at ingest with the model's visibility at request time (a `model_visibility` column on `generation_event_v2`) and add `AND model_visibility = 'public'`-style guards to `model_route_health`, `model_catalog_health`, `model_health_24h`, and `public_model_stats_refresh`; or (c) exclude `community/*` models from the *public* stats/health surfaces entirely and serve community health only to the owner (the pipes' only legitimate consumers for private rows).
2. Keep the catalog's own health attach as-is (it already only touches caller-visible entries); the leak is the raw pipes and the raw routes.
3. Consider that `model_catalog_health`'s recent-50 sample also carries `request_id`s — even for public models, exposing per-request IDs publicly is unnecessary; drop them from the public projection.
