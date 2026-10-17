# Gemini embeddings `video_url` fetch bypasses the user-media URL policy and the size cap — a single URL buffers unbounded bytes into the worker and fetches hosts every other media path refuses

## Summary

`POST /v1/embeddings` with `google/gemini-embedding-2` (aliases `embedding`, `gemini-2`) accepts multimodal `input` parts, including `video_url`. The video branch of `gen.pollinations.ai/src/embeddings/input.ts` fetched those URLs with its own private helper:

```ts
async function fetchMedia(url) {          // input.ts (removed)
    const parsed = parseRemoteMediaUrl(url);   // only checks the protocol
    const response = await fetch(parsed);      // no timeout, no host policy
    const buffer = await response.arrayBuffer();  // no size cap
    ...
}
```

Every other user-supplied media fetch in the platform goes through `fetchUserImage` (`gen.pollinations.ai/src/userImage.ts`), which enforces the shared policy the module documents as universal — *"Apply the same URL policy to every user-supplied media fetch: HTTP(S) only, with credentialed hosts, loopback names, and literal IP addresses refused"* (`shared/user-media-url.ts`) — plus the **20 MiB streaming cap** (`MAX_IMAGE_SIZE`, checked against Content-Length up front and against the running byte count while reading, so a missing or lying header cannot bypass it). The embeddings `image_url` branch uses it (`downloadImageAsBase64` → `fetchUserImage`). The `video_url` branch alone did not.

Two consequences:

1. **Unbounded memory buffering.** `arrayBuffer()` buffers the entire response before the 1.33× base64 expansion for `inlineData`, with no cap and no timeout. Any authenticated user can POST a request body of a few hundred bytes — a `video_url` pointing at an arbitrarily large file, or an endless chunked stream with no Content-Length — and drive the worker past its 128 MiB limit. This also sidesteps the route's 32 MiB request-body limit entirely: the body is just a URL; the bytes arrive over fetch. A slow or hanging origin stalls the request indefinitely while rate-limit and API-key budget reservation state is held.
2. **URL policy bypass.** `parseRemoteMediaUrl` accepted credentialed URLs (`http://user:pass@host/`), `localhost`, and literal IP hosts such as `http://169.254.169.254/` — hosts that the image branch, the image/video/audio reference-parameter validation (`params.ts` `referenceUrl`), and the chat media paths all refuse.

## Evidence

Worker-level (real route stack, mocked upstreams), on current `main` (76dfa27e):

```
POST /v1/embeddings  { model: "google/gemini-embedding-2",
                       input: [{ type: "video_url",
                                 video_url: { url: "http://169.254.169.254/latest/meta-data" } }] }
→ 200  (metadata fetched, base64-inlined, forwarded to Vertex, billed as VIDEO tokens)

POST /v1/embeddings  { ... video_url: { url: "http://localhost/latest/meta-data" } }
→ 200  (same full bypass)

POST /v1/embeddings  { ... video_url: { url: "http://user:pass@example.com/video.mp4" } }
→ 200  (credentialed URL fetched)

POST /v1/embeddings  { ... video_url: { url: "http://<host>/video.mp4" } }   # 21 MiB streamed, no Content-Length
→ 200  (all 21 MiB buffered + base64'd + shipped to Vertex)
```

The contrast, same route, same request shape — only the part type differs:

```
POST /v1/embeddings  { input: [{ type: "image_url",
                                 image_url: { url: "http://169.254.169.254/latest/meta-data" } }] }
→ 400  "Invalid media URL ...: private or credentialed URLs are not allowed."
```

Red tests before the fix: 4 × `expected 200 to be 400`. After the fix: all 5 tests in `test/embeddings/video-url-media-policy.test.ts` pass — the three refused URL shapes 400 before any fetch (the mock records zero requests to the refused hosts, Vertex is never called), and the 21 MiB response is cut off at the 20 MiB cap mid-stream with a 400 `image_too_large`.

## Fix

`gen.pollinations.ai/src/embeddings/input.ts`: route the `video_url` fetch through the shared `fetchUserImage` guard (the same one the `image_url` branch already uses), mapping `UserImageError` to the embeddings error contract exactly as the image branch does; delete the private `parseRemoteMediaUrl`/`fetchMedia`. Net diff: −45/+31 in one file, plus the regression tests. No behavior change for any accepted input: public HTTP(S) video URLs under 20 MiB embed exactly as before, with the same Content-Type relaying and the same `mime_type` override.

## Why it matters

- **Memory safety:** one URL per request can OOM the worker that serves it; on a busy shared deployment that is a cheap remote-triggered DoS, and it is reachable through the documented OpenAI-compatible multimodal `input` shape.
- **Policy consistency:** the same request already gets a clean 400 for `image_url` — the asymmetry means the guard is only as strong as its least-guarded branch.
- **Cost hygiene:** a hung origin holds the request, its coordinator slot, and its budget reservation open with nothing bounding it.
