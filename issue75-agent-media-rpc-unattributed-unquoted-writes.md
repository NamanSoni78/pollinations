# issue 75 — Agent-execution media writes: `computer`'s `assets publish` and `ffmpeg`'s output write unattributed, unquoted, unthrottled files to platform media storage through the internal `MediaUpload` RPC — a single 0.0002-pollen bash call can publish many max-size files

**Severity: medium (platform storage-cost and availability DoS — attacker-sustained R2 fill at a flat, byte-independent rate ~2×10⁹ bytes per pollen; no data exposure; compounds issue 65's undeletable-upload retention)**
**Status: LIVE in the tree, verified by code audit 2026-10-23 (see "Verification" — every cited gate is the absence of a check, not behavior to reproduce)**

## Summary

Issue 65 documented that the **HTTP** upload route on `media.pollinations.ai` is unthrottled for any valid key. This issue documents a second, **cheaper and lower-friction** write path into the same R2 bucket: the internal `MediaUpload` service-binding RPC, which performs **no authentication, no quota, no rate limit, no per-user attribution, and no per-byte billing** — and which is reachable through two platform MCP servers whose tool calls are billed at a **flat rate independent of bytes published**:

1. **`computer` MCP** (`apps/computer-mcp`) — the per-user persistent sandbox. Its bash tool advertises `assets publish <path>` as the way to "send files out", and one `bash` tool call can loop `assets publish` over arbitrarily many files. The tool call is billed `COMPUTER_TOOL_CALL_PRICE = 0.0002` pollen **once**, no matter how many files or bytes were published inside it.
2. **`ffmpeg` MCP** (`apps/ffmpeg-mcp`) — writes its rendered output (up to 100 MB per file) through the same RPC, billed per active container-second (~7.8×10⁻⁶ pollen/s).

The RPC itself enforces only a per-file size cap:

```ts
// media.pollinations.ai/src/media-upload.ts:49-74 — uploadUnlistedMedia (the MediaUpload
// entrypoint computer-mcp and ffmpeg-mcp call through their MEDIA binding)
export async function uploadUnlistedMedia(env, body, input) {
    const maxSize = parseInt(env.MAX_FILE_SIZE, 10) || DEFAULT_MAX_SIZE;   // 400 MiB in prod
    if (!Number.isSafeInteger(input.size) || input.size <= 0) throw ...;
    if (input.size > maxSize) throw ...;
    ...
    customMetadata: {
        uploadedAt: new Date().toISOString(),
        originalName: input.fileName?.slice(0, 253) || "",
        uploadedBy: input.uploadedBy || "pollinations-service",   // ← RPC callers pass nothing
        keyType: input.keyType || "service",
    },
```

No auth (it is an internal service binding), no quota, no per-account byte counter, no rate limit, and — unlike the HTTP route — **not even an API key presentation**: the media worker cannot tell who caused the write beyond the literal string `"pollinations-service"`.

## Evidence table

| Fact | Location |
|---|---|
| `assets publish` is the documented way out of the computer, with no byte/file limit mentioned | `apps/computer-mcp/src/server.ts:22` (BASH_DESCRIPTION), `:14-24` |
| One `share()` per published file → `media.upload(...)`, no quota, no attribution passed | `apps/computer-mcp/src/assets.ts:21-33` |
| Tool-call billing is flat per `tools/call`, regardless of work done inside the bash invocation | `apps/computer-mcp/src/server.ts:209-218` (`cost: COMPUTER_TOOL_CALL_PRICE`) |
| Flat price value | `shared/registry/mcp.ts:67` (`COMPUTER_TOOL_CALL_PRICE = 0.0002`) |
| A bash call runs one command for up to 60 s — a loop publishes many files in one call | `apps/computer-mcp/src/server.ts:41,64-66,102-106` (`COMMAND_TIMEOUT_MS = 60_000`, `workspace.runtime.exec`) |
| The media RPC validates only per-file size (400 MiB in production) | `media.pollinations.ai/src/media-upload.ts:49-74`; `media.pollinations.ai/wrangler.toml:49` (`MAX_FILE_SIZE = "419430400"`) |
| computer-mcp and ffmpeg-mcp bind the **production** media worker's `MediaUpload` entrypoint | `apps/computer-mcp/wrangler.jsonc:16`; `apps/ffmpeg-mcp/wrangler.jsonc:24` |
| ffmpeg-mcp writes its output through the same unattributed RPC | `apps/ffmpeg-mcp/worker.js:125-134` |
| ffmpeg tool call billed per active second (~7.8×10⁻⁶ pollen/s) regardless of output size | `apps/ffmpeg-mcp/worker.js:148-156`; `shared/registry/mcp.ts:61-62` |
| The only admission gate on the gen `/mcp/computer` proxy is "any positive balance" — Quest Pollen qualifies | `gen.pollinations.ai/src/routes/mcp.ts:196-203` (`requireAccountFunds(c, 0)`; `modelPaidOnly: false`) |
| RPC uploads create **no catalog row** → per issue 65 they are undeletable through the authenticated API | `media.pollinations.ai/src/media-upload.ts:75-105` (R2 put only); issue 65's delete analysis (`index.ts:897-1006`) |
| 30-day R2 lifecycle refreshed on every read keeps chosen objects alive indefinitely | issue 65's verified retention analysis (`shared/r2-storage.ts` `refreshR2ObjectTtl`) |

## Attack (attacker-only; the whole primitive costs fractions of a pollen)

1. Sign up (free) and earn/hold any positive Quest Pollen balance — that is the only admission the `/mcp/computer` proxy checks (`requireAccountFunds(c, 0)`).
2. Call the computer server's `bash` tool with a single command that creates and publishes many files in a loop, e.g.:
   ```bash
   for i in $(seq 1 60); do
       dd if=/dev/zero of=pad bs=1048576 count=100 2>/dev/null   # 100 MB, or up to the 400 MiB cap
       assets publish pad                                          # -> media.pollinations.ai/<uuid>
       rm pad
   done
   ```
   Each `assets publish` is one `media.upload` RPC; nothing counts them, caps their total, or attributes them.
3. The entire tool call — including every publish inside it — is billed **0.0002 pollen**. One pollen funds 5,000 tool calls; at the RPC's per-file cap that is a theoretical write budget of up to ~2 PB per pollen. Even at realistic emulated-shell throughput (tens of files per 60 s call), a single account sustains **gigabytes of R2 writes per hour for under 0.01 pollen**, and the ffmpeg variant adds a second sustained channel (one ≤100 MB output per ~8×10⁻⁶ pollen/s call).
4. Retention compounds it: published objects live 30 days by default, are refreshed by any read, and — having no catalog row — cannot be deleted through the authenticated media API at all (issue 65). Cleanup requires R2-side operations.
5. Because `uploadedBy` is the literal string `"pollinations-service"` and `keyType: "service"`, the platform's abuse response cannot even attribute the objects to the attacker's account from storage metadata.

The computer sandbox's own filesystem is bounded per Durable Object, so the R2 media bucket is the effective unbounded target; both the media worker's request budget and the R2 bucket are shared platform capacity.

## Verification

This is an absent-control finding: every row of the evidence table is a missing check in otherwise-working code, all cited from the current tree (`apps/computer-mcp/src/{index,server,assets}.ts`, `apps/ffmpeg-mcp/worker.js`, `media.pollinations.ai/src/media-upload.ts`, `gen.pollinations.ai/src/routes/mcp.ts`). No live writes were performed against production storage during this audit.

## Live verification addendum (2026-10-24)

End-to-end mechanism verified against production with a benign 53-byte `.txt` marker (one `tools/call` on `https://gen.pollinations.ai/mcp/computer`, Bearer key, account holding ordinary tier pollen):

- `GET /mcp` (no key) lists the computer server at 0.0002/call; MCP `initialize` → `notifications/initialized` → `tools/list` all succeed free of charge and **statelessly** (no session header required).
- One bash tool call running `… > file && assets publish file` returned `https://media.pollinations.ai/35bbb3ff-801b-4831-bf3b-1bb79f3d0530` — served `200`, `Content-Disposition: inline`, `Cache-Control: public, max-age=31536000, immutable`, CORS `*`, no CSP/`nosniff`.
- Authenticated `DELETE` on that URL with the same key: **404 Not Found** (no catalog row → undeletable, as predicted).
- Billing: the calling key's `pollenBudget` moved `1.7922652 → 1.7920652` — **exactly the flat 0.0002**, independent of the publish inside the call.

The RPC write primitive is therefore live in production; only the multi-file/size amplification was left unexercised (ethics — the economics are arithmetic on top of the verified flat rate). Runbook: `download/poc-issue75/LIVE-POC-STEPS-issue75.md`.

## Fix (minimal)

1. Attribute RPC uploads to the causing user: have computer-mcp/ffmpeg-mcp pass `uploadedBy: <Pollinations user id>` (both already know it from `x-pollinations-user-id`) and `keyType: "agent"`.
2. Enforce a per-user byte/quota counter in `uploadUnlistedMedia` for `keyType: "service"/"agent"` uploads (the quest-checker KV-counter pattern at `enter routes/account.ts:1259-1273` fits), and/or rate-limit RPC uploads per user.
3. Bound the flat tool-call billing: either charge `assets publish` output bytes (a `x-pollinations-mcp-*` usage receipt already exists as the billing channel for MCP servers), or cap publishes per tool call and file size for agent-published assets well below the HTTP upload limit.
4. Make RPC uploads deletable by their attributed owner, or place them in a shorter-lifecycle prefix.
