# Unauthenticated, unbounded writes to the `device_code` table — and pending rows are never cleaned up

## Summary

`POST /api/device/code` accepts any request, with no schema, no auth and no rate limit, and inserts an unbounded row per call:

```ts
// enter.pollinations.ai/src/routes/device.ts:111-143
.post("/code", async (c) => {
    const body = await parseFormOrJsonBody(c);   // no validator, no auth middleware on this subroute
    ...
    await db.insert(schema.deviceCode).values({
        id, deviceCode, userCode, status: "pending", expiresAt,
        clientId: body.client_id || null,   // arbitrary-length string — only the analytics event slices to 100 chars
        scope: body.scope || null,          // arbitrary-length string — the DB insert does not
    });
```

`client_id` / `scope` are stored at whatever length the caller sends (the 100-char cap is applied only to the analytics copy). Rows are deleted **only** on successful token exchange (`device.ts:335-340`); pending, denied and expired rows are never removed — `wrangler.toml` has no cron triggers and `index.ts` has no `scheduled` handler.

Related hygiene on the same flow:

- `GET /api/device/info` (`device.ts:216-242`) is fully unauthenticated: anyone who learns/guesses the 8-char `user_code` reads the flow's `status`, `scope` and `client_id`.
- `POST /api/device/deny` (`device.ts:144-174`) requires only *some* logged-in account with no binding to the flow: an attacker who learns a `user_code` can deny a victim's pending CLI login (nuisance DoS).
- `POST /api/device/token` with random codes adds an unauthenticated D1 read per request (pairing oracle — the 404/400 distinction is uniform, so code guessing is not aided, but the reads still cost quota).

## Impact

Anyone can run `while :; do curl -X POST https://enter.pollinations.ai/api/device/code -d '{"client_id":"<64KB of A>"}'; done`:

- unbounded `device_code` table growth (each row carries attacker-sized `client_id`/`scope` strings), consuming D1 storage and write quota and degrading every D1-backed account flow — a cheap, scriptable, fully unauthenticated DoS on the production database;
- expired rows accumulate forever, so the growth never self-heals even after the attack stops.

## Fix (minimal)

1. Add a zod schema to `POST /api/device/code` (bound `client_id`/`scope` lengths — e.g. 100/200 chars, matching the analytics slice) and a per-IP rate limit (the KV-throttle pattern from `/quests/check` fits).
2. Delete `device_code` rows on a schedule: a `scheduled` handler (or lazy sweep on each `/code` insert) removing `expiresAt < now` and `status != 'pending'` rows older than a day.
