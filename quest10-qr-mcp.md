Fixes #17689

# QR Codes MCP — deterministic scannable QR generation and reading

A new MCP server, `apps/qr-mcp`, that gives Pollinations agents an
ability nothing in the current fleet provides: producing a **real,
scannable** QR code, and decoding one back. Hosted agents and coding
agents on `polli mcp` reach it at `https://gen.pollinations.ai/mcp/qr`.

## Why this server

Pollinations can generate images of anything — except a working QR
code. Diffusion models draw QR-shaped noise that no reader resolves
(try it: ask any image model for a QR code, then scan the result).
Reading is just as impossible: vision models guess at codes instead of
decoding them. Every current MCP server and every open quest PR covers
other ground — `pollinations` (models, text, media, account), `ask-jev`
(decisions), `ffmpeg` (media processing), `exa` (web search), `composio`
(connectors), `computer` (persistent shell), `machines` (sandboxes), and
the open PRs for DNS, arXiv, speech, vision, GitHub repo reading, call
shapes, and Pollen cost. None of them encode or decode QR codes.

Agents need this for the boring-but-real cases: sharing a link a human
can scan, wifi credentials, payment addresses, ticket or check-in
payloads, and verifying that a code really scans before printing it.

## The two tools

**`generate_qr`** encodes text or a URL (UTF-8, up to the version-40
byte-mode capacity of 2953 bytes) as a PNG image, with `scale` (pixels
per module), `margin` (quiet zone), `error_correction` (`L`/`M`/`Q`/`H`,
so codes that must survive printing or partial damage can), and
`dark_color`/`light_color` (hex, for branded codes). Returns the image
plus dimensions, QR version, and module count. The encoder is
`qrcode-generator` (battle-tested, zero-dep), switched to UTF-8 byte
mode — its Shift-JIS default silently mojibakes non-ASCII, which the
tests pin down with a Chinese + emoji round-trip.

**`read_qr`** decodes the text behind a QR code from a PNG or JPEG
(public HTTPS URL or `data:` URI, up to 10 MiB and 12 MP), including
light-on-dark codes (dark-mode screenshots), returning the decoded text
plus version and byte count. Decoding is `jsQR` on `pngjs`/`jpeg-js`
pixel data — deterministic, not model guesswork.

## Shape

- Small Cloudflare Worker, `apps/qr-mcp`, modeled on `ask-jev-mcp` and
  `exa-mcp`: stateless streamable HTTP, no keys of its own (gen strips
  the caller's credential; the tools need nothing from gen), `deploy.json`
  + `wrangler.jsonc` + staging env like its siblings.
- Registered in `shared/registry/mcp.ts` as `billing: "usage_receipt"`
  with one tiny rate — `qr.tool_call.v1` at **0.0001 Pollen per call**
  (10,000 calls per Pollen) — covering the worker's compute, like
  `ffmpeg-mcp` prices its container seconds.
- Wired into `gen.pollinations.ai` end to end: service bindings in
  `wrangler.toml` (dev/production/staging/test), `worker-bindings.d.ts`,
  the docs page (`src/docs/mcp.md` + `test/docs.test.ts`), and proxy
  tests (`test/mcp-proxy.test.ts`): catalog listing, routing with
  billing (balance 1 → 0.9999), and the 402 empty-wallet gate with
  free `initialize`.
- One SDK-config nuance worth noting: the MCP SDK caps request bodies
  at 4 MiB by default, which would silently cap `data:` URI inputs below
  the tool's documented 10 MiB limit, so the handler raises
  `maxRequestBodySize` to 16 MiB (a 10 MiB image is ~13.7 MiB base64).

## Tests

- `apps/qr-mcp/worker.test.js` — 12 tests, all green: PNG signature and
  IHDR dimensions match metadata; **generate→read round-trips** for a
  URL, wifi string, Chinese text, and emoji; colors/scale/margin/ECC-H
  verified pixel-exact in the quiet zone and re-decoded; HTTPS fetch
  through an injected fetch impl; JPEG decoding; inverted (light-on-dark)
  decoding; clear errors for no-code-visible, non-HTTPS, wrong format,
  oversize payloads; usage headers (0.0001 + `qr.tool_call.v1` on success,
  cost 0 on failure, nothing on `initialize`); `tools/list`; batch
  rejection; `/health`.
- `gen.pollinations.ai` full suite: **2926 passed, 12 skipped** —
  including the two new proxy tests and updated docs assertions.
- `tsc --noEmit` clean, `biome check` clean, `wrangler deploy --dry-run`
  bundles at 306 KiB gzipped under `nodejs_compat`.

## What it costs to run

Nothing but its own compute — no gen calls, no external APIs, no
secrets. At 0.0001 Pollen per call, a user's entire month of QR usage
costs a fraction of one Pollen.
