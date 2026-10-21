/** A parsed absolute http(s) URL, else null.
 *
 * Rejects `javascript:`/`data:` and any other executable scheme before the
 * result is assigned to `window.location.href`. Mirrors `parseAppUrl`, which
 * guards every other `redirect` param in the dashboard.
 */
export function safeHttpUrl(value: string): URL | null {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            return null;
        }
        return url;
    } catch {
        return null;
    }
}
