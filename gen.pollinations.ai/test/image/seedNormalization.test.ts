import { describe, expect, it } from "vitest";
import { GenerateImageRequestQueryParamsSchema } from "../../src/schemas/image.js";
import {
    MAX_SEED_VALUE,
    normalizeSeed,
    normalizeSeedValue,
} from "../../src/util.js";

describe("Image Seed Normalization & Validation", () => {
    it("accepts a 13-digit timestamp (Date.now()) and normalizes it deterministically", () => {
        const timestamp = 1790366032000;
        const expectedNormalized = timestamp % MAX_SEED_VALUE;

        const parsedNumber = GenerateImageRequestQueryParamsSchema.parse({
            seed: timestamp,
        });
        expect(parsedNumber.seed).toBe(expectedNormalized);

        const parsedString = GenerateImageRequestQueryParamsSchema.parse({
            seed: String(timestamp),
        });
        expect(parsedString.seed).toBe(expectedNormalized);
    });

    it("preserves 2147483647 as 2147483647", () => {
        const parsed = GenerateImageRequestQueryParamsSchema.parse({
            seed: 2147483647,
        });
        expect(parsed.seed).toBe(2147483647);
    });

    it("preserves 42 as 42", () => {
        const parsed = GenerateImageRequestQueryParamsSchema.parse({ seed: 42 });
        expect(parsed.seed).toBe(42);
    });

    it("preserves -1 as -1 in schema parsing", () => {
        const parsed = GenerateImageRequestQueryParamsSchema.parse({ seed: -1 });
        expect(parsed.seed).toBe(-1);
    });

    it("produces identical normalized seed when repeating the same large seed", () => {
        const timestamp = 1790366032000;
        const result1 = normalizeSeedValue(timestamp);
        const result2 = normalizeSeedValue(timestamp);
        expect(result1).toBe(result2);
        expect(result1).toBe(timestamp % MAX_SEED_VALUE);
    });

    it("retains existing validation behavior for invalid inputs like -5 and abc", () => {
        expect(() =>
            GenerateImageRequestQueryParamsSchema.parse({ seed: -5 }),
        ).toThrow();

        expect(() =>
            GenerateImageRequestQueryParamsSchema.parse({ seed: "abc" }),
        ).toThrow();
    });

    it("normalizeSeed helper converts -1 to sentinel 42 and large seeds via modulo", () => {
        expect(normalizeSeed(-1)).toBe(42);
        expect(normalizeSeed(42)).toBe(42);
        expect(normalizeSeed(1790366032000)).toBe(
            1790366032000 % MAX_SEED_VALUE,
        );
        expect(normalizeSeed(undefined)).toBeUndefined();
    });
});
