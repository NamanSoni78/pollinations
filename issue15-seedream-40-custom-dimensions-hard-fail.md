# seedream-4.0 hard-fails on explicit dimensions outside the 1024–4096 custom-mode range (regression of #16587)

## Summary

Since the custom-size routing landed (#11174), an explicit `width`/`height` on `seedream-4.0` switches the Replicate payload to `size:"custom"` with **raw** dimensions. Replicate's `bytedance/seedream-4` schema only accepts custom sides within **1024–4096px** — but nothing at the gateway narrows the request to that range. A guard that used to reject out-of-range dimensions with a clean gateway 400 was **deleted by #16587** ("let providers reject bad parameters"), so today the raw values travel all the way to Replicate and come back as an upstream 422 — the request fails outright instead of being served by the preset path.

## Evidence (offline module repro, mocked `api.replicate.com`)

```
width=512 & height=512  → size:"custom", width:512,  height:512   ← out of range, forwarded raw
width=8192 & height=8192→ size:"custom", width:8192, height:8192  ← out of range, forwarded raw
width=512 (height default 1024) → size:"custom", width:512, height:1024 ← gateway synthesizes an invalid pair
no dims (control)        → size:"1K",  aspect_ratio:"1:1"          ← preset path, works
width=1536 & height=1024→ size:"custom", width:1536, height:1024   ← in range, works

simulated upstream response → "Seedream 4.0 generation failed: Replicate POST
https://api.replicate.com/v1/models/bytedance/seedream-4/predictions failed
(HTTP 422): {"detail":"Input validation failed: width: Input should be between 1024 and 4096"}"
```

`POST /v1/images/generations {"model":"seedream","size":"512x512"}` follows the same path (`routes/images.ts` `resolveParams` splits the OpenAI `size` string and preserves the `dimensionsExplicit` signal). Live reachability confirmed free-of-charge: `GET /image/...?model=seedream&width=512` passes route and schema validation (only the `paidOnly` balance gate stops a tier key before the upstream call — any funded key reaches the 422).

Repro script: `scripts/bug-verify-wave3b-seedream.mts` (module-level, fetch intercepted).

## Root cause

`gen.pollinations.ai/src/image/models/seedreamReplicateModel.ts:217-220`:

```ts
const input: SeedreamReplicateInput =
    variant.supportsCustom && safeParams.dimensionsExplicit
        ? buildCustomInput(prompt, safeParams, imageInput)   // ← raw width/height, no range check
        : buildPresetInput(prompt, safeParams, imageInput, variant);
```

Git history: #11174 (2026-05-19) added the routing **together with** `SEEDREAM4_CUSTOM_MIN/MAX` and a test ("rejects out-of-range custom dimensions with 400"); `5d41d1b` (#16587, 2026-10-06) deleted the guard, the constants, and the test in the general cleanup — leaving raw forwarding where the preset path used to serve the nearest bucket.

## Impact

- `?model=seedream&width=512`, `width=8192`, or one-sided `width=512` (POST `size:"512x512"` included) → upstream 422 instead of an image. The seedream-5 variants give identical input the preset treatment (`size:"2K"` + aspect ratio) and succeed.
- Errors surface as opaque upstream validation leaks ("Input should be between 1024 and 4096") rather than gateway semantics.
- Small explicit dimensions used to be served by the preset mode before custom routing existed; this is a hard regression for those callers.

## Fix

Branch `solution15-seedream-custom-dimension-fallback` (commit `56aff6b8`): restores `SEEDREAM4_CUSTOM_MIN/MAX` and routes out-of-range explicit dimensions to the preset path (`1K`/`2K`/`4K` bucket + closest aspect ratio) — the same treatment seedream-5 gives identical input, matching the gpt-image clamp precedent, instead of an upstream 422. Three new regression tests in `test/image/seedreamModel.test.ts` (512×512 → 1K preset, 8192×8192 → 4K preset, one-sided 512 → preset). Full suite: 2831+ passed, `tsc` clean.
