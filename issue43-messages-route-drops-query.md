# `/v1/messages` drops the request's query string when dispatching internally — `?key=`-authenticated calls 401 on the inner route, and `?safe=` (or a body `safe` field) is silently ignored, so opt-in privacy redaction the user asked for never runs

## Summary

`gen.pollinations.ai/src/routes/messages.ts:138-141` rewrites the incoming request for the internal dispatch to the chat-completions handler:

```ts
const response = await dispatch(
    new Request(new URL("/v1/chat/completions", c.req.url), { ... }),
    c,
);
```

`new URL(<path-absolute>, base)` **discards the base URL's query string** (WHATWG behavior; verified: `new URL("/v1/chat/completions", "https://gen/x?safe=privacy&key=abc")` → `https://gen/v1/chat/completions`). The dispatch is a full `app.fetch` (`src/index.ts:281-283`), so the inner request re-runs the entire middleware chain — auth included — without the caller's query.

Two concrete breakages:

1. **`?key=` auth 401s.** `extractApiKey` (`shared/auth/api-key.ts:195-212`) reads the key from the `authorization` header, `x-api-key`, or **the query string**. A caller authenticating with `POST /v1/messages?key=sk_…` (the documented, browser-friendly auth style that works on every other gen route) passes the outer route's auth, then the inner dispatch carries no credentials at all → 401 with no hint why.
2. **`?safe=` and body `safe` are silently ignored.** On `/text`, `/image`, `/audio`, `/v1/chat/completions` (query and body, `routes/generation-handlers.ts:184-187`) and `/v1/responses` (`src/text/responses/safety.ts:78-81`), `safe=privacy` opts the request into redaction/secrets-blocking. On `/v1/messages` the query is dropped by the URL rewrite, and `messagesToChatRequest` (`src/text/messages/translate.ts:231-263`) does not copy the `safe` field into the rebuilt chat body (the `/v1/messages` schema is `.passthrough()` and keeps it, but nothing reads it). The only working channel is the `Pollinations-Safe` **header** (headers are copied at `messages.ts:135`). Result: a Claude-Code-style client posting `{"safe":"privacy", …}` or `?safe=privacy` gets zero redaction — raw PII/API keys flow to the provider — while believing it asked for the documented protection.

## Fix

In `messages.ts`, before dispatch, restore the caller's effective query state on the internal URL:

```ts
const internalUrl = new URL("/v1/chat/completions", c.req.url);
const safe = request.safe ?? c.req.query("safe");
if (safe !== undefined) internalUrl.searchParams.set("safe", String(safe));
// (the inner chat route's cache key already includes `safe` when present)
```

and/or copy `safe` in `messagesToChatRequest`. For the key-auth case, either forward `extractApiKey`'s result via an internal header the auth middleware honors, or copy the `key` param onto the internal URL. Regression tests: `POST /v1/messages?key=<valid>` returns 200 (today 401); `POST /v1/messages?safe=privacy` causes `X-Safety-Applied: privacy` (today absent).
