/**
 * Small text helpers proposed for shared app use.
 */

/** Truncate to at most `max` characters, appending an ellipsis when cut. */
export function truncate(text, max) {
    if (max <= 0) return "";
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
}

/** Capitalize the first letter. */
export function capitalize(text) {
    if (!text.length) return text;
    return text[0].toUpperCase() + text.slice(1);
}

/** The longest line of a block of text. */
export function longestLine(text) {
    const lines = text.split("\n");
    let longest = "";
    for (const line of lines) {
        if (line.length > longest.length) longest = line;
    }
    return longest;
}

/** Count words, collapsing any run of whitespace. */
export function countWords(text) {
    if (!text.trim()) return 0;
    return text.trim().split(/\s+/).length;
}

/** Clamp a value into [min, max]. */
export function clamp(value, min, max) {
    if (min > max) [min, max] = [max, min];
    return Math.min(Math.max(value, min), max);
}

/** Retry an async operation until it succeeds or attempts run out. */
export async function retry(operation, attempts = 3, delayMs = 500) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
}

