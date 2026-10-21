# media's HTTP upload paths don't cap `originalName` — a multipart filename (or JSON `name`) of a few KB exceeds R2's 2 KB customMetadata limit and the upload 500s; the service-binding path already slices to 253 chars, the HTTP paths forgot

## Summary

The service-binding upload path caps the stored filename:

```ts
// media.pollinations.ai/src/media-upload.ts:86
originalName: input.fileName?.slice(0, 253),
```

The HTTP paths don't:

```ts
// index.ts:607 (raw/JSON paths)
originalName: fileName || "",          // no length cap
```

with `fileName` sourced from an **unbounded busboy multipart filename** (`multipart-upload.ts:162`) or the JSON body's `name` field (`z.string()`, `index.ts:203-206`).

`originalName` is written into the R2 object's customMetadata (`media-upload.ts:84-89`). R2 caps customMetadata at ~2 KB per object, so a part with a ~3 KB filename makes the `put` throw — the client gets an opaque `500 {"error": "Upload failed"}` (and on the custom-ID path, the failed conditional-put leaves the id taken-but-unbacked, forcing the documented 409-on-retry behavior). Deterministic, trivially reproducible per request — an easy source of confused support traffic and a dirty error class.

## Fix

Apply the same slice the service path uses (or a 400 validation) on both HTTP ingestion paths:

```ts
originalName: fileName ? fileName.slice(0, 253) : "",
```

Regression test: multipart upload with a 3 KB filename → 400 (or 200 with truncated name), not 500.
