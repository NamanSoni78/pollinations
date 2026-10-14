# POST image generation rejects a string data-URI image with a misleading error

## Summary

`POST /v1/images/generations` with a **string** `image` value containing a base64 data URI fails with `400 "Invalid media data URI: expected base64-encoded data."` — even though the URI is perfectly valid. The **same URI in array form** (`"image": ["data:..."]`) and the **same URI on `/v1/images/edits`** both work. The string-splitting logic splits data URIs on their base64 comma.

## Live evidence (reproduced against production)

```
$ curl -X POST https://gen.pollinations.ai/v1/images/generations \
    -H "Authorization: Bearer sk_..." -H "content-type: application/json" \
    -d '{"prompt":"add a red hat","image":"data:image/png;base64,iVBOR...","model":"black-forest-labs/flux.1-kontext-pro","size":"256x256"}'
→ HTTP 400
  {"message":"Invalid media data URI: expected base64-encoded data.","code":"invalid_image_url"}

# the IDENTICAL URI as an array element:
$ curl -X POST ... -d '{"prompt":"add a red hat","image":["data:image/png;base64,iVBOR..."],...}'
→ HTTP 200, image generated
```

## Root cause

`gen.pollinations.ai/src/image/params.ts` — the `image` transform splits string values on `|` or `,`:

```ts
return value.includes("|") ? value.split("|") : value.split(",");
```

A base64 data URI always contains exactly one comma (`data:image/png;base64,<payload>`), so it is split into `["data:image/png;base64", "<payload>"]`. The header-only fragment then fails `decodeDataUri`, producing the misleading 400. The comma-split path was built for remote-URL lists and never excluded data URIs.

## Impact

Any OpenAI-style client that sends a single inline base64 image as a plain string (a natural shape, and the exact shape the SDK's `imageGenerate` accepts) gets a nonsensical error message telling them their *valid* base64 data URI is not base64-encoded. Multipart uploads and the edits route construct data URIs internally and are unaffected, which makes the failure look random to users.

## Proposed fix

Keep data URIs whole before the separator logic: `if (value.startsWith("data:")) return [value];`

**Fix implemented in fork branch:** [`solution3-image-data-uri-string`](https://github.com/NamanSoni78/pollinations/tree/solution3-image-data-uri-string) — two-line guard + tests (data URI stays whole; comma-separated remote URL lists still split).
