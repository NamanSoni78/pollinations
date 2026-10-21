# MCP proxy: a malformed usage-receipt header throws *outside* the billing try/catch — the tool call has already executed, the caller gets an opaque 500 with the result discarded, and the platform absorbs the cost (a missing receipt is silently unbilled too)

## Summary

`gen.pollinations.ai/src/routes/mcp.ts:208-226` settles usage-receipt MCP billing like this:

```ts
const response = await binding.fetch(
    requestForMcp(c.req.raw, server, user),
);
if (server.billing === "usage_receipt") {
    const usage = parseMcpUsageHeaders(response.headers);   // ← line 211, OUTSIDE the try
    if (usage) {
        try {                                              // ← line 213
            await settleUsage(c, server, usage, startedAt);
            await c.var.frontendKeyRateLimit?.consumePollen(usage.cost);
        } catch (error) {
            c.var.log.error("MCP billing failed: {error}", { ... });
        }
    }
}
return responseForCaller(response);
```

`parseMcpUsageHeaders` (`shared/mcp-usage.ts:20-40`) **throws** on any invalid receipt — non-numeric `cost`, `status` outside 100–599, missing `tool`/`adjustmentId`:

```ts
if (
    !Number.isFinite(receipt.cost) || receipt.cost < 0 ||
    !Number.isInteger(receipt.status) || receipt.status < 100 || receipt.status > 599 ||
    ...
) {
    throw new Error("MCP server returned invalid usage metadata");
}
```

But the parse sits **before** the `try` that exists precisely to make billing failures non-fatal. So when an internal MCP worker emits a malformed receipt:

1. The tool has **already executed** (`binding.fetch` returned) — the provider cost is incurred.
2. `parseMcpUsageHeaders` throws out of the route handler → the caller receives an opaque 500 and **the tool result is discarded** — even when the result body was a perfectly good, successful tool output.
3. `settleUsage`/`consumePollen` never ran → **the user is not charged**; the platform absorbs the cost.
4. Callers retrying under the edge rate limit repeat the free execution.

The symmetric case is quieter: a worker that simply **omits** the receipt headers yields `usage === undefined` → `if (usage)` skips silently → the call is unbilled with no error anywhere.

## Scenario

Any `usage_receipt` MCP server (ffmpeg, qr, …) with a receipt bug — say a `cost` formatted as `"1e-4"` in a locale that serializes oddly, a status clamped to `0` on an internal error path, or a header dropped by a middleware — turns every one of its billed calls into: user gets 500, provider still paid, wallet untouched. The proxy's own logs show only the Hono top-level error, not the billing skip.

## Fix

Move the parse inside the existing try, and make receipt problems observable without discarding paid-for results:

```ts
if (server.billing === "usage_receipt") {
    try {
        const usage = parseMcpUsageHeaders(response.headers);
        if (usage) {
            await settleUsage(c, server, usage, startedAt);
            await c.var.frontendKeyRateLimit?.consumePollen(usage.cost);
        } else {
            c.var.log.error("MCP usage receipt missing on tools/call", { ... });
        }
    } catch (error) {
        c.var.log.error("MCP billing failed: {error}", { ... });
    }
}
return responseForCaller(response);   // ← the (already-paid) result is never dropped
```

If the maintainers prefer failing loudly on invalid receipts, return a 502 *after* attempting settlement — but the current order (500, no settlement, result gone) is the worst of the three outcomes. Add a test: mock worker returns a successful `tools/call` body with a malformed `x-pollinations-usage-cost` header → expect the response body to still reach the caller (200), and an error log/assert on the skipped settlement.
