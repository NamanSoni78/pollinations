# apps/chat streaming XSS — `marked` v12 passes inline HTML through raw, the custom escape only covers block-level tags, and the stream renderer writes straight to `dangerouslySetInnerHTML` — steals BYOP provider keys from localStorage

## Summary

The chat app renders assistant messages differently while streaming vs. after the stream settles. The final path is safe (markdown-it with `html: false`, `MemoizedMessageContent.jsx`). The **streaming** path is not:

- `apps/chat/src/utils/markdown.js:227` — `formatStreamingMessage()` calls `marked.parse(textContent, { async: false })`.
- The custom hardening, `marked.use({ tokenizer: { html(src) {...} } })` (`markdown.js:101-116`), only overrides marked's **block-level** `html` tokenizer, which fires at line starts. **Inline** tags inside a paragraph are handled by marked v12's inline `tag` tokenizer, which passes the raw tag through verbatim (`text: cap[0]` → `renderer.html(text)`).
- `sanitizeRenderedHtml()` (`markdown.js:73-81`) only rewrites unsafe `href=`/`src=` **URL values**; event-handler attributes like `onerror` are untouched.
- Sink: `apps/chat/src/components/TypewriterEffect.jsx:18-21` writes the result to `dangerouslySetInnerHTML={{ __html: html }}`, re-running every few ms on the growing slice while `isStreaming` (`MessageBubble.jsx:187-194`).

## Evidence (empirical, exact config)

Reproduced with the app's own `marked.use` override against the pinned dependency version (`apps/chat/package.json`: `"marked": "^12.0.2"`):

```js
const input = 'Here is a cute cat: <img src=x onerror="alert(document.domain)"> enjoy!';
```

Output of `marked.parse(input, { async: false })`:

```html
<p>Here is a cute cat: <img src=x onerror="alert(document.domain)"> enjoy!</p>
```

The tag survives escaped neither by the block tokenizer (not at line start) nor by the URL sanitizer (`src=x` is a harmless relative URL; `onerror` is not a URL attribute at all). The moment the closing `>` streams in, the browser parses the element on the live DOM and the handler fires on the chat origin (deployed to a Cloudflare Pages subdomain per `apps/chat/deploy.json`).

## Attack vectors (why this is not self-XSS)

Model output is only partially trusted:

1. **Community models.** The chat model picker loads gen's full model list including community models (`apps/chat/src/utils/api.js:90-115`, `community: m.community || false`) — third-party-controlled endpoints whose operators fully author every streamed token. Any user who picks that model executes the operator's payload.
2. **Prompt echo.** "Repeat after me: `<img src=x onerror=…>`" works against virtually any model.

## Impact

`apps/chat` stores BYOP (bring-your-own-provider) API keys — the user's own OpenAI/Anthropic/etc. credentials — in `localStorage` under `pollinations_byop_api_key` (`apps/chat/src/utils/api.js:4`, `BYOPModal.jsx`), plus full chat histories (`pollinations_chats`). The payload runs with the chat origin's full access to both, on every victim who streams a poisoned reply.

## Fix (smallest safe change)

Close the inline hole in `formatStreamingMessage` — any one of:

1. Extend the existing override to the inline tokenizer so inline tags are escaped as text:
   ```js
   marked.use({
     tokenizer: {
       html(src) { /* existing block-level escape */ },
       tag(src) {                    // inline counterpart — marked v12 inline rule
         const m = this.rules.inline.tag.exec(src);
         if (m) return { type: "text", raw: m[0], text: escapeHtml(m[0]) };
       },
     },
   });
   ```
2. Or run DOMPurify on the streaming output before it reaches the sink.
3. Or reuse the existing markdown-it `html: false` renderer for the streaming phase too (it is already imported and configured in the same file).

Option 1 is the minimal diff that matches the file's existing defense style. Add a regression test asserting `formatStreamingMessage('a <img src=x onerror=alert(1)> b')` contains zero raw `<img` and no `onerror=` attribute. The post-stream path is already safe and needs no change.
