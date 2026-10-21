# Stem separation bills a client-forged MP3 Xing header: ~0.0025 pollen charged for hours of ElevenLabs processing

## Summary

`stemInputSeconds()` meters the upload by reading the MP3's `Xing`/`Info` tag **from the client-supplied bytes** — specifically the 32-bit `frames` field written by whatever encoder produced the file:

```ts
// gen.pollinations.ai/src/audio/stem-separation.ts:50
const frames = view.getUint32(xing + 8);          // attacker-controlled
...
// stem-separation.ts:63-68
return (
    (frames * (version === 3 ? 1152 : 576) - delay - padding) /
    sampleRate
);
```

and `audioSeconds()` **prefers** this value over `music-metadata`'s duration whenever the codec is Layer 3 (`stem-separation.ts:78-81`). The derived `inputSeconds` is the billing base (`buildUsageHeaders(..., createAudioSecondsUsage(inputSeconds))`, `stem-separation.ts:157-165`), while ElevenLabs decodes the **real frame stream** and bills Pollen's `ELEVENLABS_API_KEY` at $0.30/min (six stems) / $0.15/min (two) (`shared/registry/audio.ts:527-533`).

An attacker crafts an MP3 whose first frame carries a `Xing` tag with `flags & 1` (frames present), `frames = 2`, and a valid `LAME`/`Lavc`/`Lavf` encoder tag, then appends tens of thousands of real 16 kbps frames — up to the 50 MB cap ≈ **7 hours of audio** that bills as **0.05 seconds**. Verified numerically with a node replication of the parser: a file with a `frames=2` header over 50 real frames computes 0.0522 s while containing 25× more audio (arbitrarily scalable).

## Attack

1. Account with a small paid balance (`elevenlabs/stem-separation` is `paidOnly: true`).
2. `POST /alpha/audio/stem-separation` with `model=elevenlabs/stem-separation`, `stem_variation_id=six_stems_v1`, crafted MP3 (≤ 50 MB).
3. Caller is billed `createAudioSecondsUsage(0.05)` ≈ 0.0025 pollen; ElevenLabs processes the full 7 h at $0.30/min → **≈ $126 of provider spend per request**. Repeatable per request (vary one byte to defeat dedup) at edge-limiter speed.

## Why existing guards don't prevent it

- The 50 MB cap bounds size, not duration (16 kbps ⇒ ~7 h).
- `format.hasAudio`/`hasVideo` checks validate only that it is audio.
- The gapless correction subtracts ~50 ms of encoder delay; nothing cross-checks the Xing `frames` count against the actual frame count, file size, or a bitrate floor.
- ElevenLabs returns no usage header to reconcile against (comment at `stem-separation.ts:155-156`); the preflight `checkBalance` uses a median-cost *estimate*, so any funded account passes.

## Fix (minimal)

Bill the **maximum** of the Xing-derived seconds, metadata duration, and a size/bitrate floor — e.g. `file.size * 8 / 320_000` (320 kbps is MP3's ceiling; a real 50 MB MP3 cannot be shorter than ~20 min). Alternatively count actual MPEG frame headers instead of trusting the Xing field. The existing test (`test/stem-separation.test.ts:36-38`) keeps passing with an honest fixture.
