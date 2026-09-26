import { CreateChatCompletionRequestSchema } from "@shared/schemas/openai.js";
import { describe, expect, it } from "vitest";
import { simpleAudioQuerySchema } from "../../src/routes/generation-handlers.js";
import { GenerateImageRequestQueryParamsSchema } from "../../src/schemas/image.js";
import { Generate3dRequestQueryParamsSchema } from "../../src/schemas/model3d.js";
import { GenerateTextRequestQueryParamsSchema } from "../../src/schemas/text.js";
import {
    MAX_SEED_VALUE,
    normalizeSeed,
    normalizeSeedValue,
} from "../../src/util.js";

describe("Seed Normalization & Validation", () => {
    it("handles Date.now() style 13-digit seeds without validation errors", () => {
        const timestamp = 1790360632000;
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

    it("preserves valid seeds within int32 range unchanged", () => {
        const validSeeds = [0, 42, 2147483647, -1];
        for (const seed of validSeeds) {
            const parsed = GenerateImageRequestQueryParamsSchema.parse({
                seed,
            });
            expect(parsed.seed).toBe(seed);
        }
    });

    it("rejects genuinely invalid seed inputs", () => {
        expect(() =>
            GenerateImageRequestQueryParamsSchema.parse({ seed: -5 }),
        ).toThrow();

        expect(() =>
            GenerateImageRequestQueryParamsSchema.parse({ seed: "abc" }),
        ).toThrow();
    });

    it("produces deterministic normalized values for large seeds", () => {
        const timestamp = 1790360632000;
        const result1 = normalizeSeedValue(timestamp);
        const result2 = normalizeSeedValue(timestamp);
        expect(result1).toBe(result2);
        expect(result1).toBe(timestamp % MAX_SEED_VALUE);
    });

    it("normalizes seeds across text, 3d, audio, and OpenAI schemas", () => {
        const timestamp = 1790360632000;
        const expected = timestamp % MAX_SEED_VALUE;

        const textParsed = GenerateTextRequestQueryParamsSchema.parse({
            seed: String(timestamp),
        });
        expect(textParsed.seed).toBe(expected);

        const d3Parsed = Generate3dRequestQueryParamsSchema.parse({
            seed: String(timestamp),
        });
        expect(d3Parsed.seed).toBe(expected);

        const audioParsed = simpleAudioQuerySchema.parse({
            seed: String(timestamp),
        });
        expect(audioParsed.seed).toBe(expected);

        const openaiParsed = CreateChatCompletionRequestSchema.parse({
            messages: [{ role: "user", content: "hi" }],
            seed: timestamp,
        });
        expect(openaiParsed.seed).toBe(expected);
    });

    it("normalizeSeed helper converts -1 to sentinel 42 and large seeds via modulo", () => {
        expect(normalizeSeed(-1)).toBe(42);
        expect(normalizeSeed(42)).toBe(42);
        expect(normalizeSeed(1790360632000)).toBe(
            1790360632000 % MAX_SEED_VALUE,
        );
        expect(normalizeSeed(undefined)).toBeUndefined();
    });
});
