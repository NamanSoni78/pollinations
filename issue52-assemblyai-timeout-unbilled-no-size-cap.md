# AssemblyAI transcription: 240 s timeout abandons the job un-billed and un-cancelled, and `/v1/audio/transcriptions` has no file-size cap — third-party spend with zero caller charge

## Summary

Two stacked gaps in the AssemblyAI transcription chain:

1. **Timeout abandons the job.** `pollAssemblyAiTranscript` polls every 2 s against a 240 s budget (`ASSEMBLYAI_TRANSCRIPTION_TIMEOUT_MS`, `gen.pollinations.ai/src/routes/assemblyai-transcription.ts:26-28`). When long audio outlives the budget, the handler throws `UpstreamError(504)` at `assemblyai-transcription.ts:291-293` — **no DELETE/cancel of the transcript is ever attempted, and no `billedUsage` is attached to the error**. Failures are billed only when the handler attaches `billedUsage` to the `UpstreamError` (`gen.pollinations.ai/src/middleware/track.ts:710-719`); usage headers (the only billing signal, `assemblyai-transcription.ts:137-140`) are set only on a completed transcript. AssemblyAI finishes the work server-side on Pollen's `ASSEMBLYAI_API_KEY` at $0.15–0.28 per audio hour (`shared/registry/audio.ts:869-871, 922-936`) — the 504'd client got the processing, Pollen pays, the caller pays nothing.

2. **`/v1/audio/transcriptions` is the only audio-upload route without a size cap.** It checks only `file.size === 0` (`gen.pollinations.ai/src/routes/audio.ts:4010-4019`), while every sibling enforces 50 MB (voice-changer/isolator at `audio.ts:694`, `:760`; stem separation at `src/audio/stem-separation.ts:109`) and text routes apply a 32 MiB `bodyLimit` (`generation-handlers.ts:32-39`). A ~100 MB Opus file (≈14 h at 16 kbps) uploads, holds a Worker execution for the full 240 s (up to ~2,400 concurrent in-flight isolates per IP at the 10 rps edge limit — a second-order DoS), and then triggers gap 1. The OpenAI API this mirrors caps uploads at 25 MB.

## Attack

1. Any funded account (`assemblyai/*` models are `paidOnly: true`).
2. `POST /v1/audio/transcriptions` with `model=assemblyai/universal-3.5-pro` and a ~100 MB low-bitrate file.
3. After 240 s the client gets a 504 and is charged nothing; AssemblyAI bills Pollen $2–4 per request for the completed transcript. Repeat at edge-limiter speed.

## Why existing guards don't prevent it

- `edgeRateLimit` (10 rps/IP) is the only rate limit for `sk_` keys; the DO limiter applies to `pk_` keys only.
- `generationAccess` checks a median-cost *estimate* — audio duration is unknown before upload.
- Nothing validates file size or duration anywhere in the chain; no deferred poll recovers the eventual `audio_duration` for billing.

## Fix (minimal)

1. Enforce a max upload size on `/v1/audio/transcriptions` (25–50 MB, matching siblings).
2. On timeout, `waitUntil` a continued poll (or a reconciliation) to recover `audio_duration` and charge via `billedUsage`; or attach a conservative `billedUsage` derived from `file.size × 8 / minimumPlausibleBitrate`.
