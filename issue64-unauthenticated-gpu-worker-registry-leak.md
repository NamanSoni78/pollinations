# issue 64 — Unauthenticated `GET /register` on gen.pollinations.ai leaks the internal GPU worker fleet

**Severity: medium (information disclosure → targeted pipeline DoS / recon)**
**Status: LIVE in production, verified 2026-10-22**

## Summary

`handleRegisterServer` serves two very different behaviors behind one route. On `GET /register` **without** a `url` query parameter it calls `handleListRegisteredServers(c)` and returns every registered GPU worker — **before any credential check**:

- `gen.pollinations.ai/src/routes/proxy.ts:681-684` — `/register` (POST and GET) is mounted **before** `.use(auth())`, so the route is intentionally unauthenticated.
- `gen.pollinations.ai/src/image/handler.ts:494-505` — the `PLN_GPU_TOKEN` check (`isAuthorizedRegisterWrite`) runs **only** when `url`/`ip`/`port` is present; the no-parameter branch falls straight through to `handleListRegisteredServers`.
- `gen.pollinations.ai/src/image/handler.ts:561-574` — the listing returns `{type, url, lastHeartbeat, lastMs}` for **all** registered workers of every type (`flux`, `zimage`, `sana`).

The worker fleet is internal infrastructure: self-hosted / rented GPU boxes (vast.ai instances and canaries) that gen selects via `fetchFromWeightedServer` (`gen.pollinations.ai/src/image/availableServers.ts:185-275`) and proxies image generation to at `${serverUrl}/generate`.

Live proof (plain `curl`, no key, no account):

```
$ curl -sS https://gen.pollinations.ai/register
[{"type":"flux","url":"https://flux-vast-04.pollinations.ai","lastHeartbeat":1792677086328,"lastMs":2139},
 {"type":"zimage","url":"https://zimage-vast.myceli.ai","lastHeartbeat":1792677099746,"lastMs":1340},
 {"type":"sana","url":"https://dreamshaper-canary-35285.myceli.ai","lastHeartbeat":1792677084799,"lastMs":54019},
 {"type":"sana","url":"https://dreamshaper-canary-51216212.myceli.ai","lastHeartbeat":1792677076374,"lastMs":920}]
```

(On `image.pollinations.ai` the same route answers `200 []` — that environment currently has an empty registry; **gen carries the populated one**.)

Direct reachability of the leaked hosts was confirmed — all four answer at their HTTPS endpoint (they 403 `/generate` without the backend token, which is correct).

Secondary weaknesses on the same route:

1. **Register tokens travel in the query string** — `extractRegisterToken` accepts the shared secret from `?token=` (or JSON body) as well as `Authorization` (`gen.pollinations.ai/src/image/handler.ts:470-478`), so the secret can land in access logs, browser history and Referer headers (same class as issue 55).
2. **No validation of the registered `url`** — `registerServer(url, typeParam)` (`gen.pollinations.ai/src/image/availableServers.ts:80`) stores any string gen is later asked to `fetch(`${url}/generate`)` from (with the backend token attached at `createAndReturnImages.ts:236-239`). With the register token this would be a server-side-request primitive; today it is defense-in-depth that is missing, not an exploitable path (writes require the secret).

## Attack

Attacker-only, zero interaction, zero cost:

1. `curl https://gen.pollinations.ai/register` — full fleet topology: hostnames, fleet size and composition (`flux`/`zimage`/`sana`), naming scheme (vast.ai rentals, canary instances), per-worker latency and liveness.
2. With the fleet mapped, flood the worker hosts directly (they are publicly routable) — e.g. cheap unauthenticated requests to exhaust the GPU workers / their tunnels, bypassing gen's edge rate limiting entirely (gen's `edgeRateLimit` never sees traffic that goes straight to the worker host). This degrades or kills the public image pipeline while the platform's own limiter stays idle.
3. The listing doubles as a free **health/latency oracle** for tuning follow-up abuse (e.g. picking the slowest `sana` canary, watching when fleets scale up/down, correlating which worker served a request by latency).

## Fix (minimal)

- Gate the listing: in `handleRegisterServer`, move the `isAuthorizedRegisterWrite` check **before** the no-`url` early return (i.e. require the token for `handleListRegisteredServers` too), or at minimum require an authenticated caller with `account:machines`.
- Drop the `?token=` query channel in `extractRegisterToken` (keep `Authorization` + JSON body).
- Validate the registered URL at write time: `https:` scheme, hostname allowlist (e.g. `*.pollinations.ai`, `*.myceli.ai`) or at least a private-range blocklist, mirroring `shared/community-endpoint-urls.ts`.
