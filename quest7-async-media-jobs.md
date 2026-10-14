Fixes #17256

# Request media asynchronously: submit now, collect the result later

API users start a long image, video, audio or 3D generation, get an id back right away, and collect the result later — instead of holding one connection open for minutes or resending the identical request after a disconnect.

## The protocol

Any coordinated generation route (images, edits, audio, video, 3D, and the GET image routes) accepts RFC 7240 `Prefer: respond-async`:

```bash
curl -X POST https://gen.pollinations.ai/v1/images/generations \
  -H "Authorization: Bearer $POLLEN_API_KEY" \
  -H "Prefer: respond-async" \
  -H "Content-Type: application/json" \
  -d '{"model":"black-forest-labs/flux.1-schnell","prompt":"a cat on the moon"}'
```

The answer is a job handle, immediately:

```json
{
  "id": "3f9c1a…e2",
  "status": "queued",
  "urls": {
    "status": "https://gen.pollinations.ai/v1/jobs/3f9c1a…e2",
    "result": "https://gen.pollinations.ai/v1/jobs/3f9c1a…e2/result"
  }
}
```

- `GET /v1/jobs/{id}` — status: `queued` / `processing` / `succeeded` / `failed`, with `Retry-After: 2` while running.
- `GET /v1/jobs/{id}/result` — the generated content, the same response the synchronous call would have returned (OpenAI JSON for `/v1/images/generations`, raw media for GET routes). Early collection answers `425 Too Early`; failed jobs replay the captured error response.

## Semantics

- **One generation, one charge.** The job id is the SHA-256 of the request identity, so resubmitting the identical request — because you disconnected, or hours later — joins the same job instead of starting a new one. Polling and collection are free. A caller that prefers respond-async always receives the job handle, even when the result is already cached.
- **Owner-only reads.** Only the account that submitted (or joined) a job can read its status or result.
- **24-hour collection window** on settled jobs; the result itself lives in the durable generation cache.
- **Zero changes to the sync path** — no `Prefer` header, no behavior change, byte for byte.

## How it's built (minimal, reuse-first)

The platform already runs disconnected generations detached under the `GenerationCoordinator` Durable Object — that machinery is what kept sync disconnects recoverable. This PR extends it rather than adding a parallel system:

- `GenerationCoordinator.submit()` registers a job and returns without waiting; the generation runs under the existing alarm exactly as for a disconnected sync caller. `jobStatus()` reports it per submitting account; settled jobs keep a compact record for 24 h late collection.
- New `GET /v1/jobs/:id` + `GET /v1/jobs/:id/result` routes (`routes/jobs.ts`), auth-required, replaying results from the durable cache and failures from the captured error snapshot.
- The dedup middleware answers `Prefer: respond-async` with the 202 handle; the response cache skips its short-circuit for such requests so submission stays uniform.
- SDK: `submitJob` / `getJob` / `getJobResult` / `waitForJob` with full types; README and OpenAPI docs (new **Async Jobs** tag + `docs/async-jobs.md`) document the protocol.

## Verified

- Full test suite green (2,801 tests) with two new integration tests through the real worker: submit → poll → collect end-to-end; **single execution and single charge** per job (asserted against the balance and the billing events); owner-only reads (stranger → 404, anonymous → 401); resubmitting the identical request after settlement returns the same job handle with no second charge; and the sync path untouched (no header, byte-identical response, no `Location`).
- Typecheck clean; biome clean; no lock-file changes; no changes outside the jobs feature.

## SDK

```ts
const job = await pollinations.submitJob({
  path: "/v1/images/generations",
  body: { prompt: "a cat on the moon", model: "black-forest-labs/flux.1-schnell" },
});
// …minutes or hours later:
const response = await pollinations.waitForJob(job.id);
const image = await response.arrayBuffer();
```
