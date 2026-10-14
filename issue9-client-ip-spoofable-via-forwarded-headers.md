# Spoofable X-Forwarded-Host lets any direct-hit caller control their "client IP" and bypass per-IP rate limits

## Summary

`getRealClientIp` honors `X-Original-Client-IP` whenever the **client-supplied** `X-Forwarded-Host` names a known public host (`gen.pollinations.ai` etc.). On any path that reaches the worker **without** the CloudFront edge in front, both headers are attacker-controlled: a caller can present a trusted `X-Forwarded-Host` together with a rotating `X-Original-Client-IP` and pick an arbitrary "client IP" per request — defeating every per-IP rate limit and poisoning abuse telemetry.

## Attack path (code-verified; unit-test repro below)

1. `shared/public-origin.ts` trusts `X-Forwarded-Host` when it *names* a known host. The comment explains why comparing with `c.req.url.host` cannot identify a proxy hop — on Cloudflare custom-domain routes the worker is invoked on the public host either way, so **the header's presence is the only signal, and clients control it**.
2. `shared/client-ip.ts` then returns `x-original-client-ip` verbatim. The doc comment's safety argument ("the CloudFront `pln-gen-viewer-ip` function overwrites any client-supplied value, so a spoofed X-Original-Client-IP cannot survive the CloudFront hop") is correct for the edge hop — but on a direct hit there is no CloudFront hop, and the same comment's assumption that direct hits carry "only CF-Connecting-IP" does not hold: an attacker adds both headers.
3. Direct-hit surfaces exist: the comment itself names `*.myceli.ai`, and `gen.pollinations.ai` currently resolves straight to Cloudflare (104.18.7.216), where `x-original-client-ip` passes through untouched.

Consequences:
- `rate-limit-durable.ts` builds the publishable-key limiter identity as `pk_<keyId>:ip:<ip>` from this spoofable value — each request lands on a **fresh limiter bucket**, so the pk rate limit that protects a key owner's wallet from a single visitor is fully bypassable.
- The edge limiter and `ipSubnet`/`ipHash` abuse telemetry key on the same spoofed value.
- The existing spoofing test (`test/proxy-client-ip.test.ts`) only covers an *unknown* forwarded host — not a known host on a direct hit.

Unit-test repro of the vulnerability on current `main`:

```ts
const spoofed = mockContext("https://gen.myceli.ai/text/hi", {
    "x-forwarded-host": "gen.pollinations.ai",   // client-controlled, names a trusted host
    "x-original-client-ip": "9.9.9.9",           // client-controlled
    "cf-connecting-ip": "203.0.113.42",          // the caller's real address (unforgeable)
});
getRealClientIp(spoofed) // → "9.9.9.9"  (should be "203.0.113.42")
```

Rotate `9.9.9.N` and every request gets a fresh per-IP identity.

## Why a naive fix is risky

The worker cannot distinguish "request traversed the edge" from "request claims it did" by headers alone — **except** via `cf-connecting-ip`, which Cloudflare sets to the actual TCP peer and clients cannot forge. Through the real edge (CloudFront + Origin Shield), `cf-connecting-ip` is the edge's egress IP; on a direct hit it is the caller's real IP. So the forwarded original IP should be honored **only when the TCP peer is provably the trusted edge** — otherwise fall back to `cf-connecting-ip` (which is exactly right on direct hits).

Longer-term options maintainers may prefer:
- a signed proof header from the `pln-gen-viewer-ip` function (needs Lambda@Edge or a shared-secret scheme — CloudFront Functions have no crypto/secrets), or
- validating `cf-connecting-ip` against AWS's published CloudFront origin-facing prefix list (`com.amazonaws.global.cloudfront.origin-facing`).

## Proposed fix (conservative, in-repo)

Honor `x-original-client-ip` only when **both** hold: (a) `X-Forwarded-Host` names a known public host (existing check), and (b) `cf-connecting-ip` lies within the trusted edge's egress space the repo itself documents — Origin Shield `64.252.64.0/18` plus the CloudFront edge egress range the existing tests model (`130.176.x`). Direct hits keep their real `cf-connecting-ip`. No existing test behavior changes; new tests pin the spoof case.

**Fix implemented in fork branch:** [`solution9-client-ip-edge-egress-gate`](https://github.com/NamanSoni78/pollinations/tree/solution9-client-ip-edge-egress-gate) — egress-prefix gate in `shared/client-ip.ts` with the rationale documented, spoof tests for IPv4 and IPv6 direct hits, and the logger test's mock updated to model a real edge hop.
