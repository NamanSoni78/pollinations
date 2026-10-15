Fixes #17384

# Return an OAuth 400 (never a 500, never SQL) for malformed device-token bodies

`POST /api/device/token` is the public, unauthenticated RFC 8628 token endpoint — the URL every CLI prints next to its `user_code`. Today two malformed-body classes blow past the OAuth error contract and surface as `500 INTERNAL_ERROR`:

1. **Body is not valid JSON**

```bash
curl -s -X POST https://enter.pollinations.ai/api/device/token \
  -H 'Content-Type: application/json' --data 'not json'
# => 500 {"error":{"message":"Unexpected token 'o', \"not json\" is not valid JSON","code":"INTERNAL_ERROR"}}
```

2. **`device_code` is a JSON object** — the response echoes the raw SQL statement and its params back to the client:

```bash
curl -s -X POST https://enter.pollinations.ai/api/device/token \
  -H 'Content-Type: application/json' --data '{"device_code":{"a":1}}'
# => 500 {"message":"Failed query: select \"id\", \"device_code\", ... from \"device_code\" ...
#         where \"deviceCode\".\"device_code\" = ? limit ?\nparams: [object Object],1", ...}
```

RFC 6749 §5.2 / RFC 8628 §3.5 require `400 {"error":"invalid_request","error_description":"…"}` — and internal parser/SQL details must never reach the client. The same raw-parse hole exists on `POST /api/device/deny` (L218), and a JSON `null` body crashes even the good path: `parseFormOrJsonBody()` runs `Object.entries(null)` → 500, on `/api/device/code`, `/api/device/token` **and** `/api/oauth/token`.

## Root cause

`enter.pollinations.ai/src/routes/device.ts`:

- `POST /token` (L242) and `POST /deny` (L218) read the body with a bare `c.req.json()` that has no `.catch`, while `POST /code` and `/api/oauth/token` already go through the shared `parseFormOrJsonBody()` (form + JSON wires, non-string fields filtered).
- `exchangeDeviceCode()` only checks truthiness before passing `device_code` to Drizzle's `eq()` — an object sails into the query as a param and the driver error serializes the whole statement.
- `parseFormOrJsonBody()` has no null-body guard: JSON `null` parses successfully, so the `.catch` never fires and `Object.entries(null)` throws.

## The fix (minimal, reuse-first)

- `POST /token` and `POST /deny` parse through the existing `parseFormOrJsonBody()` — matching the OAuth path, gaining form-encoded support (RFC 8628 §3.5) for free.
- `parseFormOrJsonBody()` degrades JSON `null` / scalar / array bodies to an empty record instead of throwing (arrays would otherwise produce index-keyed garbage fields).
- `exchangeDeviceCode()` guards `device_code` at runtime (`typeof === "string"`) so a non-string can never reach the query builder, defense-in-depth for the exported, shared handler.
- The helper is generic over the env schema so the auth-augmented context on `/deny` typechecks.

Result: every malformed input answers `400 {"error":"invalid_request","error_description":"device_code required"}` (or the existing `userCode is required` envelope on `/deny`); no parser text, no SQL, no 500.

## Verification

`enter.pollinations.ai/test/device-auth.test.ts` + `test/oauth-code.test.ts` gain 8 regression tests, all red on stock `main` (500s observed) and green after the fix:

| probe | before | after |
|---|---|---|
| `POST /api/device/token` body `not json` | 500 INTERNAL_ERROR | 400 `invalid_request` |
| `POST /api/device/token` `{"device_code":{"a":1}}` | 500 + SQL leak | 400 `invalid_request`, no SQL in body |
| `POST /api/device/token` body `null` | 500 | 400 `invalid_request` |
| `POST /api/device/token` form-encoded `device_code` | 500 (json() throw) | 400 `authorization_pending` — reached the grant checks |
| `POST /api/device/deny` body `not json` (with session) | 500 | 400 |
| `POST /api/device/deny` `{"userCode":{"a":1}}` | 500 (`toUpperCase` TypeError) | 400 |
| `POST /api/device/code` body `null` | 500 | 200 (issues a code, like any form-parse failure) |
| `POST /api/oauth/token` body `null` | 500 | 400 `unsupported_grant_type` |

Full enter suite: **1473 passed**, `tsc --noEmit` clean, `biome check` clean. No behavior change for well-formed requests — the happy-path tests (`full flow: approve device code, poll for key`, OAuth code grant, narrowed-scope echo, …) all pass unmodified.

Branch: `quest/17384-device-token-oauth-400` (fork). Diff: 3 files, +128/−7 — one source file and two test files.
