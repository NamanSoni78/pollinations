# SDK `imageEdit()` with multiple images sends an illegal body and gets a 400 — the documented example is broken

## Summary

The JS SDK's `imageEdit()` passes `options.image` through verbatim. When a user passes **multiple source images as an array of URL strings** — exactly what the SDK's type advertises (`image?: string | string[]`) and what its README documents — the request body becomes `{"image": ["url1", "url2"]}`, which the edits endpoint's schema rejects. Every multi-image edit fails with a 400.

## Live evidence (reproduced against production)

```
# The exact body the SDK's documented usage produces:
$ curl -X POST https://gen.pollinations.ai/v1/images/edits \
    -H "Authorization: Bearer sk_..." -H "content-type: application/json" \
    -d '{"prompt":"combine these images","image":["https://example.com/a.jpg","https://example.com/b.jpg"]}'
→ HTTP 400 {"message":"Invalid input","code":"BAD_REQUEST","details":{"name":"UpstreamError"}}

# README (packages/sdk/README.md) documents this usage:
#   image: ['https://example.com/a.jpg', 'https://example.com/b.jpg']
```

The API's JSON edits contract (`shared/schemas/openai.ts`, `CreateImageEditRequestSchema.image`) is a `string | Array<{ image_url: string }>` — the OpenAI shape. The generations schema, by contrast, accepts `string | string[]`, which is why `imageGenerate` works with arrays and only edits is objects-only.

## Root cause

`packages/sdk/src/client.ts` (`imageEdit`):

```ts
if (options.image) {
    body.image = options.image;   // string[] sent verbatim — API rejects it
}
```

The SDK's own tests only exercise the single-string form (`client.test.ts`), which is why the documented multi-image path slipped through.

## Impact

- A README-documented, type-advertised SDK feature 100% fails against the live API.
- The 400 body (`"Invalid input"`) gives the user no hint that reformatting the array would fix it.

## Proposed fix

Map the array to the OpenAI shape at the request boundary (1 line):

```ts
body.image = Array.isArray(options.image)
    ? options.image.map((image_url) => ({ image_url }))
    : options.image;
```

**Fix implemented in fork branch:** [`solution5-sdk-image-edit-array`](https://github.com/NamanSoni78/pollinations/tree/solution5-sdk-image-edit-array) — the mapping plus a request-shape test asserting `[{image_url}, {image_url}]` is sent. (Alternative: relax the API union to also accept `string[]`, matching the generations schema — happy to do that instead if preferred.)
