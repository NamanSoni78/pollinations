# /models/status forwards the unvalidated `minutes` parameter — Tinybird template errors leak and documented bounds are unenforced

## Summary

The `minutes` query parameter on `GET /models/status` is passed through to the public Tinybird pipe without validation. The OpenAPI description documents it as an integer between 1 and 10080, and the sibling `traffic` parameter *is* validated — but `minutes` is not: garbage values surface raw upstream template errors, and absurd values run unbounded window scans against the shared pipe.

## Live evidence (reproduced against production)

```
$ curl "https://gen.pollinations.ai/models/status?minutes=banana"
→ HTTP 400
  {"error": "Template Syntax Error: Error validating 'banana' to type Int32",
   "documentation": "https://docs.tinybird.co/cli/advanced-templates.html"}

$ curl "https://gen.pollinations.ai/models/status?minutes=99999999"
→ HTTP 200   # a full multi-year window scan on the shared pipe, docs say max 10080
```

## Root cause

`gen.pollinations.ai/src/routes/model-status.ts`:

```ts
const minutes = c.req.query("minutes");
if (minutes !== undefined) url.searchParams.set("minutes", minutes);  // forwarded raw

// contrast with the validated sibling two lines above:
if (traffic !== "all" && traffic !== "regular")
    return c.json({ error: "traffic must be all or regular" }, 400);
```

## Impact

- Raw upstream provider errors (and a third-party docs URL) leak into Pollinations API responses.
- The documented 1–10080 bound is fiction; arbitrarily expensive scans can be pushed onto the shared Tinybird pipe.
- Inconsistent with the route's own `traffic` validation.

## Proposed fix

Mirror the `traffic` check: parse and bound-check `minutes` (integer, 1–10080) before contacting the upstream.

**Fix implemented in fork branch:** [`solution7-models-status-minutes-validation`](https://github.com/NamanSoni78/pollinations/tree/solution7-models-status-minutes-validation) — validation with a clean 400, tests for `abc / 0 / -5 / 1.5 / 99999999` (upstream never contacted), and the upstream-error passthrough test preserved via a valid-minutes failure.
