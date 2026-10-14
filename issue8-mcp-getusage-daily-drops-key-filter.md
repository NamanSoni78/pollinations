# MCP `getUsage({daily: true, key: [...]})` silently drops the key filter — and its description says it can't filter

## Summary

The MCP `getUsage` tool forwards the `api_key_ids` filter on the history endpoint but **silently drops it on the daily endpoint**, even though the daily API accepts it. A user asking "daily usage for key k1" receives daily usage for **all** keys with no indication. The tool's own description compounds the bug by claiming `key` is "(history only)".

## Evidence

The API accepts the filter on daily usage (verified against production):

```
$ curl "https://gen.pollinations.ai/account/usage/daily?api_key_ids=<keyId>&days=2" \
    -H "Authorization: Bearer sk_..."
→ HTTP 200 {"usage":[],"count":0}
```

`packages/mcp/src/services/accountService.js`:

```js
params: daily
    ? { days }                                   // ← api_key_ids dropped
    : { days, limit, models: ..., api_key_ids: key?.join(",") },
```

and the tool schema:

```js
key: z.array(z.string()).optional()
    .describe("Only these API key ids, from listKeys (history only)"),   // ← wrong
```

`mcp.pollinations.ai` runs this code (apps/mcp imports `packages/mcp/src`), so the behavior is production-visible. The MCP's own test codified the drop as the expected URL (`accountService.test.js`: daily → `/account/usage/daily?days=14` with no filter).

## Impact

- Wrong data returned without any signal: multi-key users (e.g. one key per app) cannot get a single key's daily usage through MCP.
- The misleading description teaches agents the wrong API contract, so they won't even try.

## Proposed fix

Forward `api_key_ids` in the daily branch (the API supports it) and drop the "(history only)" note from the `key` description.

**Fix implemented in fork branch:** [`solution8-mcp-usage-daily-key-filter`](https://github.com/NamanSoni78/pollinations/tree/solution8-mcp-usage-daily-key-filter) — 2-line param fix + description correction + updated test asserting the filter is forwarded.
