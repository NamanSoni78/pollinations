const RANDOM_ID_ALPHABET =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function generateRandomId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(
        bytes,
        (byte) => RANDOM_ID_ALPHABET[byte % RANDOM_ID_ALPHABET.length],
    ).join("");
}

export function safeRound(amount: number, precision: number = 6): number {
    if (!Number.isFinite(amount) || Number.isNaN(amount)) {
        return 0;
    }
    if (Math.abs(amount) < 10 ** -(precision + 2)) {
        return 0;
    }
    const factor = 10 ** precision;
    return Math.round(amount * factor) / factor;
}

export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes =
        buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

const TRUE_TOKENS = ["true", "1", "yes", "on"];
const FALSE_TOKENS = ["false", "0", "no", "off", ""];

/**
 * Parse boolean-ish query/body values. Returns null when the value is not
 * recognizably boolean, so callers decide between defaulting and rejecting.
 * (z.coerce.boolean() treats the string "false" as true.)
 */
export function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value !== "string") return null;

    const normalized = value.trim().toLowerCase();
    if (TRUE_TOKENS.includes(normalized)) return true;
    if (FALSE_TOKENS.includes(normalized)) return false;
    return null;
}

// Maximum seed value - use INT32_MAX for compatibility with strict providers like Vertex AI
export const MAX_SEED_VALUE = 2147483647; // INT32_MAX (2^31 - 1)

/**
 * Normalizes a raw seed input value before schema limit validation.
 * Safe positive integer numbers or digit-only numeric strings greater than MAX_SEED_VALUE (2147483647)
 * are mapped deterministically into the supported INT32 seed range using modulo MAX_SEED_VALUE.
 */
export function normalizeSeedValue(val: unknown): unknown {
    if (typeof val === "number") {
        if (Number.isSafeInteger(val) && val > MAX_SEED_VALUE) {
            return val % MAX_SEED_VALUE;
        }
        return val;
    }
    if (typeof val === "string") {
        const trimmed = val.trim();
        if (/^\d+$/.test(trimmed)) {
            const num = Number(trimmed);
            if (Number.isSafeInteger(num) && num > MAX_SEED_VALUE) {
                return num % MAX_SEED_VALUE;
            }
        }
    }
    return val;
}

/**
 * `seed=-1` used to mean "pick a random seed", which produced a different image
 * on every call. Generation is now single-flighted and cached by request URL,
 * so a sentinel that randomizes downstream would key one URL to an arbitrary
 * result. Map it to a fixed seed instead: callers get a reproducible result and
 * providers only ever see a real seed or none. Callers wanting variation pass
 * their own varying seed.
 */
export const SENTINEL_SEED = 42;

export function normalizeSeed<T extends number | undefined>(seed: T): T {
    return (seed === -1 ? SENTINEL_SEED : seed) as T;
}
