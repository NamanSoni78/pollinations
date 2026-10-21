# Device `/approve` and OAuth `/api/oauth/code` store a client-supplied `apiKey` verbatim — no binding of the delivered credential to the consenting user (amplifies the confirmed /authorize XSS)

## Summary

Both consent-closing endpoints validate *everything except the credential being delivered*:

**Device flow** — `POST /api/device/approve` (`enter.pollinations.ai/src/routes/device.ts:33-39` schema, `173-213` handler, `317-355` delivery) requires only a session and a pending `userCode`, then writes the request body's `apiKey` string and `apiKeyId` into KV verbatim; the device later receives that exact string as its `access_token`:

```ts
// device.ts:185-197
await c.env.KV.put(
    `device-key:${device.deviceCode}`,
    JSON.stringify({
        key: body.apiKey,        // never validated: not checked to exist,
        keyId: body.apiKeyId,   // be enabled, be an sk_, or belong to `user`
        expiresIn: body.expiresIn ?? null,
        scope: body.scope ?? null, // echoed to the CLI as the granted scope
    }),
    ...
```

The repo's own tests prove arbitrary strings pass: `test/device-auth.test.ts:383-396` posts a fabricated `apiKey: "sk_test_device_expiry"` and the flow returns 200 and later issues it as `access_token`.

**OAuth code flow** — `POST /api/oauth/code` (`enter.pollinations.ai/src/routes/oauth.ts:130-148`) rigorously validates `clientId` (registered app key or metadata document), `redirectUri` (exact allowlist match), and PKCE challenge — but stores `key: body.apiKey` from the request body verbatim for redemption (`oauth.ts:215-220`). `expiresIn` is likewise echoed from the body and can misreport the key's real lifetime.

## Attack

This is the server-side half of the confirmed `/authorize` javascript: redirect XSS (issue40): any script running in the enter origin can call `/approve` (or `/code`) with an **attacker-chosen** key string — the victim's device/CLI then silently authenticates as the attacker's account (session-fixation-style), or the legitimate app's OAuth exchange delivers an attacker-controlled token. It also permits **scope spoofing**: the echoed `scope` is whatever the approver sends, so a device that trusts the token response's `scope` sees permissions the delivered key may not have.

Independently of issue40: a leaked 8-char `user_code` (from `verification_uri_complete` URLs — `device.ts:137` — referrers, screenshots, logs) plus any account lets an attacker (a) mark the victim's device approved with `userId` recorded as themselves, (b) inject an arbitrary token string for the victim's device, (c) probe code status unauthenticated via `/api/device/info` (which distinguishes `invalid code` / `expired` / `pending` / `already used` — an oracle with no rate limit; RFC 8628 §5.2 expects `slow_down` throttling on `/token`).

Related hardening in the same file: `exchangeDeviceCode` skips the client binding when the caller simply omits `client_id` (`device.ts:295-308` — `body.client_id` is checked only if volunteered; when `device.clientId` is set it should be required).

## Fix (minimal)

In `/approve`, load the `apikey` row by `body.apiKeyId` and require `row.referenceId === user.id`, `row.prefix === "sk"`, `row.enabled !== false`, not expired, and `hash(body.apiKey) === row.key` (the hasher pattern already exists in `github-secret-scanning.ts:128`). Derive `scope`/`expiresIn` from the key row rather than the body. Mirror the same ownership check in `/code` — or mint the key server-side inside `/code` so the raw key never transits the client. Add per-IP/per-code rate limits to `/api/device/{info,token}`.
