import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    createMCPResponse,
    createTextContent,
    postChatCompletion,
} from "../../packages/mcp/src/utils/coreUtils.js";

const DEFAULT_MODEL = "openai";

const imageSchema = z
    .string()
    .min(1)
    .describe(
        "Public HTTPS image URL or data:image/...;base64 data URI (max 20 MiB per image).",
    );

const visionOptions = {
    model: z
        .string()
        .optional()
        .describe(
            "Vision-capable text model (default: openai). Call listModels with type=text to see options.",
        ),
    detail: z
        .enum(["low", "high", "auto"])
        .optional()
        .describe(
            "Image detail: low for quick takes, high for fine print (default: auto).",
        ),
    max_tokens: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum tokens to generate."),
};

const SYSTEM_PROMPT =
    "You are a precise visual assistant. Answer only from what is visible " +
    "in the images. When something is not visible or unclear, say so " +
    "instead of guessing.";

const DESCRIBE_ONE =
    "Describe the image in detail: subjects, setting, actions, style, " +
    "colors, composition, notable details, and any visible text.";
const DESCRIBE_SEVERAL =
    "Describe each image in detail, then summarize what they share and how " +
    "they differ.";
const READ_TEXT_PROMPT =
    "Extract all text visible in this image, verbatim, in natural reading " +
    "order. Preserve line breaks and approximate the layout with Markdown. " +
    "If no text is visible, reply exactly: No visible text.";

/**
 * Send images plus an instruction to a vision-capable model through gen's
 * chat-completions endpoint, with the caller's key. One shared path for
 * every tool in this server.
 */
async function lookAtImages(
    { images, prompt, model, detail, max_tokens },
    context,
) {
    const result = await postChatCompletion(
        {
            model: model ?? DEFAULT_MODEL,
            messages: [
                {
                    role: "system",
                    content: SYSTEM_PROMPT,
                },
                {
                    role: "user",
                    content: [
                        ...images.map((url) => ({
                            type: "image_url",
                            image_url: { url, detail },
                        })),
                        { type: "text", text: prompt },
                    ],
                },
            ],
            max_tokens,
        },
        context,
    );

    const answer = result.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || answer.length === 0) {
        throw new Error("Vision model returned no answer.");
    }

    const content = [createTextContent(answer)];
    if (result.usage) {
        content.push(createTextContent({ usage: result.usage }, true));
    }
    return createMCPResponse(content);
}

function buildServer() {
    const server = new McpServer(
        { name: "eyes-mcp", title: "Eyes MCP", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );
    server.registerTool(
        "look",
        {
            description:
                "Look at images with a vision model and answer a question about them. " +
                "Ask about anything visible: what is shown, whether something matches a " +
                "requirement, which of several images fits best, or how they differ. " +
                "Omit the question for a detailed description. Use it to check generated " +
                "images against their prompt, read screenshots, or judge photos.",
            inputSchema: z.object({
                images: z
                    .array(imageSchema)
                    .min(1)
                    .max(32)
                    .describe(
                        "Images to look at. Pass several to compare or consider them together.",
                    ),
                question: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "What to find out. Omit for a detailed description. With several " +
                            "images, ask about them together (for example, their differences).",
                    ),
                ...visionOptions,
            }),
        },
        async ({ images, question, model, detail, max_tokens }, context) =>
            lookAtImages(
                {
                    images,
                    prompt:
                        question ??
                        (images.length > 1 ? DESCRIBE_SEVERAL : DESCRIBE_ONE),
                    model,
                    detail,
                    max_tokens,
                },
                context,
            ),
    );
    server.registerTool(
        "read_image_text",
        {
            description:
                "Read the text visible in an image (OCR). Returns the exact text in " +
                "natural reading order with Markdown line breaks — for screenshots, " +
                "scans, receipts, signs, forms, and handwriting. Use look instead to " +
                "answer questions or describe what the image shows.",
            inputSchema: z.object({
                image: imageSchema,
                ...visionOptions,
            }),
        },
        async ({ image, model, detail, max_tokens }, context) =>
            lookAtImages(
                {
                    images: [image],
                    prompt: READ_TEXT_PROMPT,
                    model,
                    detail,
                    max_tokens,
                },
                context,
            ),
    );
    return server;
}

const mcpHandler = createMcpHandler(() => buildServer(), {
    legacy: "stateless",
    onerror: (error) => console.error(error),
});

function readBearerToken(request) {
    const authorization = request.headers.get("authorization");
    if (!authorization) return null;

    const [scheme, token] = authorization.trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() !== "bearer" || !token) {
        return null;
    }
    return token;
}

function unauthorizedResponse() {
    return Response.json(
        {
            error: "unauthorized",
            message: "Send a Pollinations API key as a bearer token.",
        },
        {
            status: 401,
            headers: {
                "WWW-Authenticate": 'Bearer realm="eyes-mcp.pollinations.ai"',
            },
        },
    );
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/health" && request.method === "GET") {
            return Response.json({
                name: "eyes-mcp",
                transport: "streamable-http",
                endpoint: "/",
                stateless: true,
            });
        }

        if (url.pathname !== "/") {
            return new Response("Not found", { status: 404 });
        }

        const token = readBearerToken(request);
        if (!token) return unauthorizedResponse();

        if (
            request.method === "POST" &&
            Array.isArray(
                await request
                    .clone()
                    .json()
                    .catch(() => null),
            )
        ) {
            return Response.json(
                {
                    error: "invalid_request",
                    message: "Batch requests are not supported.",
                },
                { status: 400 },
            );
        }

        return mcpHandler.fetch(request, {
            authInfo: {
                token,
                clientId: "pollinations-api-key",
                scopes: [],
            },
        });
    },
};
