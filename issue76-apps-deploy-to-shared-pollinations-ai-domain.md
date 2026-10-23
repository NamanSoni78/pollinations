# issue 76 — Platform demo apps deploy to the shared `pollinations.ai` registrable domain: an XSS in any one of them (issue 33's chat XSS is live in the tree) is platform-wide cookie territory that user sites were deliberately isolated from

**Severity: high (attack-surface multiplier with a concrete, live trigger — the unfixed issue 33 streaming XSS executes on `chat.pollinations.ai` and thereby gains `Domain=pollinations.ai` cookie authority; enables cookie tossing toward `enter.pollinations.ai`'s session cookie, platform-branded phishing, and widens `#api_key=` fragment-key exposure to the apex zone)**
**Status: LIVE — deployment topology verified against the deploy pipeline source and live-verified 2026-10-24 (`https://catgpt.pollinations.ai/` → 200, `https://chat.pollinations.ai/` → 200, `https://openclaw.pollinations.ai/` → 200, all `server: cloudflare`)**

## Summary

The repo's own reasoning for putting **user sites** on `*.pollinations.app` (a separate registrable domain) is that pages there must never gain cookie scope over `pollinations.ai` services (`issue31`/`issue32` analysis; `gen.pollinations.ai/src/sites.ts` comment: "user sites at `<name>.pollinations.app`"). That isolation discipline is **not applied to the platform's own demo/browser apps**: the deployment pipeline publishes a whole family of `apps/*` projects to **`<subdomain>.pollinations.ai`** — the same registrable domain that hosts `enter.pollinations.ai` (auth, sessions, keys), `gen.pollinations.ai` (gateway + docs with pasted API keys), and `media.pollinations.ai`.

Any script executing on any of these app origins can set cookies with `Domain=pollinations.ai`, which are then transmitted to **every** sibling service — including `enter.pollinations.ai`. This is exactly the capability the `.app` zone exists to withhold.

## Evidence table

| Fact | Location |
|---|---|
| Pages-app deployment publishes to `<subdomain>.pollinations.ai` (`PUBLIC_ZONE = "pollinations.ai"`, `publicDomain = ${subdomain}.${PUBLIC_ZONE}`) | `operations/deployment/cloudflare-pages.cjs:18, 276-282` |
| Deployed pages apps on the platform zone include `chat`, `catgpt`, `openclaw`, `react`, `virtual-makeup`, `opposite-prompt-generator`, `map-to-isometric`, `product-packaging-designer`, `changelog-generator`, `sirius-cybernetics-elevator-challenge`, `oauth-test` | `apps/*/deploy.json` (`"target": "pages"`, `"subdomain": ...`) |
| Worker apps also land on the zone: `openwebui`, `websim`, `mcp`, `floret`, `mama-barbara`, `machines-mcp`, `exa-mcp`, `ffmpeg-mcp`, `computer-mcp`, `composio-mcp`, `ask-jev-mcp` | `apps/*/deploy.json` (`"target": "worker"`, `"subdomain": ...`) |
| Live confirmation | `curl -I https://catgpt.pollinations.ai/` → `HTTP/2 200`, `server: cloudflare` (same for `chat.` and `openclaw.`, 2026-10-24) — re-verified 2026-10-24 for nine hosts incl. `websim.`, `openwebui.`, `floret.`, with `enter.`/`gen.`/`media.` on the same zone |
| The chat app's streaming XSS is still present in the tree (issue 33): inline `onerror` HTML survives `marked.parse`, sink `dangerouslySetInnerHTML` | `apps/chat/src/utils/markdown.js:101-116, 227`; `apps/chat/src/components/TypewriterEffect.jsx:18-21` |
| Legacy OAuth fragment flow delivers `#api_key=sk_...` onto several of these zone origins | `apps/virtual-makeup/src/App.jsx:90-93`; `apps/openclaw/src/script.js:72-78`; `apps/ai-dungeon-master/src/hooks/useAuth.ts:33-47`; `apps/sirius-cybernetics-elevator-challenge/src/hooks/ui.ts:49-62` |
| The gen docs page keeps a user-pasted API key usable in-browser on the `gen.pollinations.ai` origin | `gen.pollinations.ai/src/docs-client/request-auth.ts` (`polli-connect` element; `onRequestBuilt` injects `Bearer <key>`); `gen.pollinations.ai/src/routes/docs.ts:493-506` |
| enter's session cookie is not `__Host-`-prefixed, so a domain-wide cookie with the same name is a legal, transmissible collision candidate | `shared/db/better-auth.ts` (Better Auth default cookie names, no prefix override); `enter.pollinations.ai/src/auth.ts` (no `cookiePrefix`/`__Host-` configuration) |

## Attack (attacker-only, chaining the already-filed issue 33)

1. The attacker gets script execution on `chat.pollinations.ai` via issue 33 (community-model stream or a "repeat after me" prompt echo — both attacker-controllable inputs to the streaming renderer).
2. From that origin, the payload sets a cookie with parent-domain scope:
   ```js
   document.cookie = "better-auth.session_token=<attacker-chosen-value>; Domain=pollinations.ai; Path=/; Max-Age=31536000";
   ```
   This is impossible from `*.pollinations.app`; it is trivially possible on the app zone.
3. Every subsequent request the victim's browser makes to `enter.pollinations.ai` now carries **two** `better-auth.session_token` cookies (the host-only session one and the attacker's domain-wide one). Per RFC 6265 §5.4 they are ordered by path length, then **earliest creation first** — so the outcome depends on relative creation times:
   - the domain cookie is ordered first whenever it was created before the login cookie (e.g., the XSS ran while logged out, after a logout, or the attacker-set cookie predates the session) — then server-side cookie parsing that reads the first match (Hono `getCookie`, the default in Better Auth's Workers adapter) reads **the attacker's value**: the victim's session resolves to the attacker-chosen token (session fixation / confusion) or to garbage (a logout-DoS the victim cannot clear from the app's UI, because the app only deletes its host-only cookie);
   - even when ordered second, it is a persistent poison payload waiting for the next login-order edge, and it can also shadow other unprefixed cookie names (`pollen_session`, flow cookies).
4. Independently of cookies, the XSS origin is now a `*.pollinations.ai` host: phishing pages, OAuth-style popups, and "platform" prompts inherit the apex brand, and the `#api_key=sk_...` fragment URLs produced by the legacy flow on sibling app origins are one shared-brand domain away from every user's mental model of "the platform".

Note the severity math: issue 33 alone was scoped to "steals BYOP keys from the chat app's localStorage". On the shared registrable domain, the same payload additionally gets a **cookie-authority primitive against the auth service** that no `.pollinations.app` origin could ever obtain.

## Verification

- Topology: read from `operations/deployment/cloudflare-pages.cjs` and the `apps/*/deploy.json` manifests; live-confirmed via HEAD requests on 2026-10-24 (`catgpt`, `chat`, `openclaw` — all 200 on `pollinations.ai` subdomains).
- Issue 33's sink is still present in the current tree (files re-read this audit; no fix landed).
- No cookie was actually set and no victim browser was exercised: the cookie-tossing step is standard browser cookie behavior (RFC 6265 §5.4 / §4.1.2.4) and is documented as such, consistent with the repo's own prior reasoning for isolating user sites on `.app`.

## Addendum (same audit, 2026-10-24): the app family includes a full third-party application with its own XSS CVE history

`apps/openwebui` deploys a containerized **Open WebUI** (upstream, Apache-2.0 — a large third-party codebase with a public history of stored-XSS CVEs in chat/markdown rendering) to `openwebui.pollinations.ai`, open to **any Pollinations account** (`ENABLE_OAUTH_SIGNUP: "true"`, `DEFAULT_USER_ROLE: "user"`, `apps/openwebui/worker.js:29-77`). Each user chats through their own consent-minted key (`OAUTH_AUTHORIZE_PARAMS: {expiry: 365, budget: 20}`), and model selection includes the community catalog — the same "model output is partially trusted" premise as issue 33, but executed by a third-party web app whose patch level now has to be tracked as part of the platform's `pollinations.ai` origin security. Any future Open WebUI rendering CVE becomes, by deployment, a cookie-authority XSS on the apex zone (this issue's chain). This strengthens the case for the zone relocation in the fix, which resolves the whole class at once.

## Fix (minimal)

1. Move browser/demo apps off the apex zone: deploy pages/worker apps to `<name>.pollinations.app` (the zone already used for user sites and already excluded from auth scope), or a dedicated `*.apps.pollinations.ai` zone with the same isolation property. This is a routing/config change in `operations/deployment/cloudflare-pages.cjs` + DNS, not an app rewrite.
2. Independently, harden enter's session cookies against tossing: configure Better Auth to use `__Host-`-prefixed cookie names (or otherwise prefix+Secure+no-Domain), which no subdomain script can shadow because `__Host-` cookies cannot carry a `Domain` attribute.
3. As defense-in-depth, add a `Content-Security-Policy` (`frame-ancestors`, `object-src 'none'`) on the app origins so a platform-origin XSS has a harder time being framed/embedded into phishing flows against enter.
