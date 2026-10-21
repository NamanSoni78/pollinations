# floret fetches arbitrary user-influenced URLs server-side with no host validation (SSRF class) and leaks response bodies into the chat

## Summary

floret's media tools fetch whatever URL the LLM's tool arguments carry — and those arguments are driven by the end user's chat message ("edit this image: http://…", "transcribe this audio: http://…"). The fetch path (`apps/floret/src/floret/tools/gen.py:125-179`, `_fetch_bytes`; `apps/floret/src/floret/tools/media.py:61-67`, `_read_source`) uses a shared client with **redirect-following and no host validation**:

```python
# gen.py:34-43
client = httpx.AsyncClient(follow_redirects=True, timeout=180)

# gen.py:145
async with _http_client().stream("GET", url, headers=headers) as resp:
```

On error, the first 300 bytes of the response body are echoed back into the conversation (`gen.py:155-157`, `RuntimeError(f"HTTP {resp.status_code} fetching {url[:120]}: {error}")`) — a readable response oracle for probing internal endpoints. Entry points: `edit_image` (`gen.py:247`), `transcribe` (`:459`), `transform_audio` (`:484`).

The repo already has a canonical guard — `shared/user-media-url.ts` (blocks localhost, IPv6, literal private IPv4, credentialed hosts) — used by `apps/ffmpeg-mcp/worker.js:36-42`, but floret never ports or replicates it. Same defect class as the polli SSRF finding (#35) in a different app.

## Attack

1. Chat with floret: "transcribe the audio at http://169.254.169.254/latest/meta-data/" (or any internal/link-local target reachable from the container's network).
2. The container (`apps/floret/worker.js:8-20`, internet-enabled) fetches it server-side, follows any redirects, and returns status + first 300 bytes of the body into the reply.

Impact depends on the floret container's network position (Cloudflare egress can't reach RFC1918, but link-local metadata services, DNS-name-based internal endpoints, and redirect chains remain reachable; the oracle also enables internal port/endpoint enumeration and egress abuse).

## Fix (minimal)

Port `shared/user-media-url.ts`'s validation to a Python equivalent and run every `_fetch_bytes` URL through it, re-validating on each redirect hop (or set `follow_redirects=False` and loop with validation, as `ffmpeg-mcp/worker.js:47-60` already does).
