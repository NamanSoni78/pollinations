# Anonymous `GET /register` on gen dumps the entire community GPU worker pool (IP:port, type, liveness, latency); the registration token is accepted from the query string, and non-443 workers default to plaintext `http://` — which also carries the backend token in the clear

## Summary

Three compounding problems on the self-hosted GPU pool registration route:

**1. The listing is unauthenticated.** `gen.pollinations.ai/src/routes/proxy.ts:681-682` mounts the route before the auth middleware:

```ts
.post("/register", handleRegisterServer)
.get("/register", handleRegisterServer)
// Auth required for all endpoints below (API key only - no session cookies)
.use(auth())
```

And inside the handler, the no-parameter branch lists **before** the write-authorization check (`gen.pollinations.ai/src/image/handler.ts:494-507`):

```ts
if (c.req.method === "GET") {
    ...
    if (!url) return handleListRegisteredServers(c);   // ← lists first, no auth

    if (!(await isAuthorizedRegisterWrite(c, {}))) {   // ← only writes are guarded
        return c.json({ success: false, message: "Unauthorized" }, 401);
    }
```

`handleListRegisteredServers` (`handler.ts:561-574`) returns every live entry for every type via `getRegisteredServers` (`availableServers.ts:105-126`): `{type, url, lastHeartbeat, lastMs}` — i.e. **contributor GPU endpoints with their public IP:port, pool type, freshness, and measured latency**, as public JSON:

```bash
$ curl https://gen.pollinations.ai/register
[{"type":"flux","url":"http://203.0.113.7:8000","lastHeartbeat":...,"lastMs":412}, ...]
```

**2. Token in the query string.** `handler.ts:475-478` accepts the registration token from `?token=` — it leaks into access logs, referrers, and any intermediary (the codebase's own `extractApiKey` comments warn about exactly this pattern for API keys).

**3. Plaintext default.** `handler.ts:500` derives `scheme = port === "443" ? "https" : "http"`, so any registered `ip:port` worker is treated as HTTP unless it happens to sit on 443; `createAndReturnImages.ts:230-237` then sends the `x-backend-token: PLN_GPU_TOKEN` header over that cleartext channel. Anyone on-path harvests the shared backend token — which is a **write** credential: with it they can register their own servers into the pool (gen would then forward user prompts to them, a prompt-exfiltration and content-integrity risk).

## Why it matters

- **Reconnaissance for targeted DoS.** The pool is community-contributed capacity. Publishing each contributor's home-hosted IP:port with liveness and latency is a ready-made target list for anyone who wants to degrade image generation — the exact contributors the platform depends on.
- **Credential hygiene.** Query-string tokens and cleartext backend auth both leak the shared GPU secret to logs and networks.
- Legacy route or not, it is live in production and the fix is a two-line reordering plus a scheme default flip.

## Fix

1. In `handleRegisterServer`, move the `isAuthorizedRegisterWrite` check **above** the `if (!url) return handleListRegisteredServers(c)` branch, so the listing requires the same token as writes.
2. Stop accepting the token from `?token=` (header-only).
3. Default to `https` and require opt-in for plaintext (or refuse plaintext entirely), so `x-backend-token` is never sent over cleartext.
4. Consider dropping `lastMs`/`lastHeartbeat` from the response even for authorized callers — operators need the URL, not the telemetry.

Regression test: `GET /register` with no credentials → 401 (today: 200 + pool list); `GET /register?token=...&url=...` → 401 telling the caller to use the header (today: accepted).
