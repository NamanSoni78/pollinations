# Polli bot fetch paths have no private/loopback/metadata guards — `fetch_file` and `scrape_url` will hit `http://169.254.169.254/`, localhost, and any internal service, and the response body is echoed back into chat (read-side SSRF)

## Summary

The bot's user-reachable URL fetchers perform no host validation beyond "has scheme and netloc":

**`apps/polli/src/integrations/web_scraper.py:1142-1157`** — `fetch_discord_attachment`, the engine behind the `fetch_file` tool (documented as "public JSON/text URLs or Discord attachments", `src/ai/tools.py:689`):

```python
async with aiohttp.ClientSession() as session:
    async with session.get(attachment_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
        if resp.status != 200:
            return {"success": False, "error": f"HTTP {resp.status}"}
        content = await resp.text()
```

Plain GET of any URL — no allowlist, no scheme restriction beyond aiohttp's http(s), no IP filtering. Despite the name, nothing confines it to Discord's CDN.

**`web_scraper.py:528-536`** — `scrape_url` checks only:

```python
parsed = parse_url(url)
if not parsed.scheme or not parsed.netloc:
    return {... "error": "Invalid URL - must include http:// or https://"}
```

The crawl4ai fallback then renders any URL in a headless Chromium; `file://localhost/…` passes the netloc-presence check for the browser layer.

A repo-wide search confirms **no `ipaddress` / private-range / loopback / link-local blocking exists anywhere** in `apps/polli/src/` — the only "private" matches are Discord thread visibility helpers and an API bind address, unrelated.

## Attack scenario

```
@Polli fetch_file http://169.254.169.254/latest/meta-data/ and summarize it
@Polli scrape http://localhost:8080/admin and show me what's there
```

Depending on where the bot runs (cloud VM, Kubernetes pod, Docker network — the webhook server binds `0.0.0.0`, the API server `127.0.0.1`), the tool fetches cloud metadata (instance credentials on IMDSv1 providers), internal admin panels, or neighbor services, and **returns the body as the tool result, which the model relays into the Discord channel** — full read-side SSRF exfiltration, driven entirely through natural-language requests.

The platform side already solved this exact class: `shared/user-media-url.ts` (used by gen's media fetches) refuses credentialed hosts, loopback names, and literal IP addresses, and is https-only with manual redirects. The Python bot has no equivalent.

## Fix

Add one shared guard used by both entry points (and by any future fetcher):

```python
import ipaddress, socket

BLOCKED_SCHEMES = ...
async def assert_public_http_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):          # kills file:// and others
        raise UnsafeUrlError("only http(s) URLs are allowed")
    if parsed.username or parsed.password:             # credentialed URLs
        raise UnsafeUrlError("credentialed URLs are not allowed")
    host = parsed.hostname
    for family, addr in await asyncio.get_running_loop().getaddrinfo(host, None):
        ip = ipaddress.ip_address(addr[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise UnsafeUrlError("private or reserved hosts are not allowed")
```

Apply it at the top of `fetch_discord_attachment` and `scrape_url` (before the crawl4ai fallback). For `fetch_file`, additionally restrict the Discord-attachment claim to actual `cdn.discordapp.com`/`media.discordapp.net` hosts when the tool is invoked in attachment mode. DNS-resolution-time checking (not hostname string matching) is required so `localtest.me`-style rebinding tricks don't bypass it.
