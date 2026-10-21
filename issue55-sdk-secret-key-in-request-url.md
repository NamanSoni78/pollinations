# SDK puts the secret API key in the request URL for image/video/audio GETs — proxy/CDN/APM/HAR leakage of a live `sk_`

## Summary

`packages/sdk/src/client.ts:351-383` — `buildQueryParams()` appends the secret key as a query parameter **by default**:

```ts
private buildQueryParams(
    params: Record<string, unknown>,
    includeKey: boolean = true,          // ← default ON
): string {
    ...
    // Add API key to query params if set and requested
    if (includeKey && this.apiKey) {
        searchParams.set("key", this.apiKey);   // :379 — secret into URL
    }
```

`image()` (`:418-421`, `:463-466`), `video()` (`:696-699`, `:740-743`) and `audio()` (`:1069-1071`, `:1073-1075`) then `fetch()` that URL **while also sending `Authorization: Bearer`** via `getHeaders()` (`:318-327`). `model3d()` (`:771-780`) passes `includeKey=false` — proving the safe default exists but isn't used.

## Impact

Every `pollinations.image()/video()/audio()` call carries `?key=sk_...` on the wire. The key lands in:

- forward/reverse proxy and CDN logs,
- APM/error trackers that capture request URLs (a thrown `fetch` error stringifies the URL),
- HAR exports and devtools network panels when the SDK runs in a browser.

`stripKeyFromUrl()` (`:187-191`) only sanitizes the `.url` field *returned to the caller* — the outgoing HTTP request still leaks, and the header-based auth makes the query param pure redundancy.

## Fix (minimal)

Flip the default: `includeKey: boolean = false` (one-line change at `client.ts:353`) — or remove the parameter entirely; the `Authorization` header already authenticates all three endpoints. `model3d()` already proves both flows work without it.
