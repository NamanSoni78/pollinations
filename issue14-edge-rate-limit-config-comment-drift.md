# Edge rate limiter runs at 10,000 req/10s per IP — comments claim 10 req/s (100 per 10 s): a 100x drift

## Summary

The per-IP Cloudflare native edge rate limit is configured at **10,000 requests / 10 seconds (~1,000 req/s per IP)** in **all three deploy environments** (production, staging, test) of `gen.pollinations.ai/wrangler.toml`. Two code comments describe the same middleware as **"~10 req/s per IP (100 requests per 10 seconds)"** — a 100x discrepancy between the documented defense and the deployed one. Whichever side is the intended value, the repo currently lies about one of them: either the config was meant to be 100/10s and ships 100x too permissive, or the comments were never updated when the limit was set.

## Live evidence (reproduced against production)

```
$ rg 'simple' gen.pollinations.ai/wrangler.toml          # production, staging AND test:
simple = { limit = 10000, period = 10 }

# comment side — gen.pollinations.ai/src/middleware/rate-limit-edge.ts:12:
 * Edge rate limiter: ~10 req/s per IP (100 requests per 10 seconds)
# gen.pollinations.ai/src/routes/proxy.ts:416:
 // Edge rate limiter: first line of defense (10 req/s per IP)

$ # burst probe against production (free cached endpoint, one IP):
160 × GET https://gen.pollinations.ai/models  completed in 8.8 s
→ 200 × 160, throttled × 0          # a 100-per-10s limit would have 429'd ~60 requests in
```

Git history: both the config value and the comments were born together in the repo restructure and have never been changed — the drift is original, not a regression.

## Root cause

No single line is wrong in isolation; the bug is the unchecked divergence:

- `wrangler.toml` `[[env.<name>.ratelimits]] EDGE_RATE_LIMITER` — `limit = 10000, period = 10` (three copies, one per env)
- `rate-limit-edge.ts:12` and `proxy.ts:416` — "10 req/s per IP (100 requests per 10 seconds)"

## Impact

- **If the comment reflects intent** (a genuine per-IP quota): production currently allows a single IP to push 1,000 req/s through the edge shield indefinitely — the "first line of defense" against traffic spikes is effectively off, and every downstream layer (per-key PollenRateLimiter, provider quotas, cache) absorbs the flood.
- **If the config reflects intent** (a flood shield, deliberately loose to protect CGNAT/NAT users and the media-heavy frontend, with per-key limits doing the real work): the comments still mislead every contributor who reads the middleware, capacity-plans against 10 req/s, or writes user-facing rate-limit documentation from the code.

## Fix

Branch `solution14-edge-rate-limit-docs` (commit `a5c67e6`) takes the zero-risk side of the decision: the two comments now state the actual configured value (1,000 req/s per IP, 10,000 per 10 s), name the wrangler.toml block where it is set per environment, and document the layering (edge = flood shield; per-key Pollen limits live in the PollenRateLimiter durable object). If maintainers instead want the documented 100/10s behavior, the change is the three `simple =` lines in `wrangler.toml` — flagged here deliberately: that direction risks 429 storms for legitimate users behind shared IPs (office NAT, the image gallery frontend bursts well past 100 requests per 10 s per IP), so it needs an ops decision, not a drive-by.

Docs-only change; full suite: 2796 passed.
