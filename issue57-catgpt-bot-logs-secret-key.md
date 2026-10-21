# catgpt-bot writes a spendable `sk_` API key into persistent, world-readable log files

## Summary

The catgpt Discord bot embeds its secret API key into the image-generation URL and then logs the full URL:

```ts
// apps/catgpt-bot/bot.ts:88
if (API_KEY) url += `&key=${encodeURIComponent(API_KEY)}`;

// bot.ts:98-99
async function fetchImage(url: string): Promise<Buffer> {
    log(`Image API request: ${url}`);      // ← logs ?key=<sk_...>
    const res = await axios.get(url, { headers: AUTH, ... });  // Bearer also sent
```

`API_KEY` is `TEXT_POLLINATIONS_TOKEN` — a spendable secret `sk_` key (SOPS-encrypted at rest in `apps/catgpt-bot/secrets/env.json`, decrypted into the process env at runtime).

The logs persist in two places:

- `apps/discord-bot-family/start-all.sh:53` — `tsx bot.ts >> /tmp/discord-bot-catgpt.log 2>&1`: every generation writes the key-bearing URL to `/tmp/discord-bot-catgpt.log` (default umask → world-readable, appended forever, never rotated).
- `apps/discord-bot-family/systemd/catgpt-bot.service:15-17` — `StandardOutput=journal`: the same lines persist in journald.

Any local user, log shipper, monitoring agent, or backup that reads these files obtains a live Pollinations secret and can spend the owner's Pollen.

## Why existing guards don't prevent it

SOPS protects the key *at rest in git*, not at runtime. `fetchImage` already authenticates with `Authorization: Bearer` (`bot.ts:100-101`), so the `&key=` query param is pure redundancy — nothing relies on it.

## Fix (minimal)

1. Delete `bot.ts:88` (keep the Bearer header).
2. Make `log()` redact `key=[^&]+` before printing URLs.
3. Rotate `TEXT_POLLINATIONS_TOKEN` — it has been written to production logs.

(Distinct from the known catgpt *web app* img-src key leak: that one ships a publishable key to the browser; this one logs a **secret** key server-side.)
