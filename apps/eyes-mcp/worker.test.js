import assert from "node:assert/strict";
import test from "node:test";
import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import worker from "./worker.js";

const TOKEN = "sk_test_request_scoped";
const EXPECTED_TOOLS = ["look", "read_image_text"];

function localFetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    return worker.fetch(request);
}

async function connectClient(options = {}, token = TOKEN) {
    const client = new Client(
        { name: "eyes-mcp-worker-test", version: "0.0.1" },
        { capabilities: {}, ...options },
    );
    const transport = new StreamableHTTPClientTransport(
        new URL("https://eyes-mcp.pollinations.ai"),
        {
            fetch: localFetch,
            requestInit: {
                headers: { Authorization: `Bearer ${token}` },
            },
        },
    );
    await client.connect(transport);
    return client;
}

function visionResponse(answer) {
    return Response.json({
        id: "chatcmpl-test",
        model: "openai/gpt-5.4-nano",
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: answer },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: 650,
            completion_tokens: 40,
            total_tokens: 690,
        },
    });
}

test("serves health and requires bearer auth", async () => {
    const health = await worker.fetch(
        new Request("https://eyes-mcp.pollinations.ai/health"),
    );
    assert.equal(health.status, 200);
    assert.equal((await health.json()).endpoint, "/");

    const unauthorized = await worker.fetch(
        new Request("https://eyes-mcp.pollinations.ai", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        }),
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(
        unauthorized.headers.get("www-authenticate"),
        'Bearer realm="eyes-mcp.pollinations.ai"',
    );

    const oldEndpoint = await worker.fetch(
        new Request("https://eyes-mcp.pollinations.ai/mcp"),
    );
    assert.equal(oldEndpoint.status, 404);
});

test("serves current and 2025 Streamable HTTP without sessions", async () => {
    const modern = await connectClient({
        versionNegotiation: { mode: "auto" },
    });
    assert.equal(modern.getProtocolEra(), "modern");
    const modernTools = (await modern.listTools()).tools;
    assert.deepEqual(
        modernTools.map(({ name }) => name).sort(),
        EXPECTED_TOOLS,
    );
    await modern.close();

    const legacy = await connectClient();
    assert.equal(legacy.getProtocolEra(), "legacy");
    assert.deepEqual(
        (await legacy.listTools()).tools.map(({ name }) => name).sort(),
        EXPECTED_TOOLS,
    );
    await legacy.close();
});

test("rejects JSON-RPC batches", async () => {
    const response = await worker.fetch(
        new Request("https://eyes-mcp.pollinations.ai", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify([
                { jsonrpc: "2.0", id: 1, method: "tools/list" },
            ]),
        }),
    );
    assert.equal(response.status, 400);
});

test("sends images and the question to chat completions", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
        calls++;
        assert.equal(
            String(input),
            "https://gen.pollinations.ai/v1/chat/completions",
        );
        assert.equal(init.method, "POST");
        assert.equal(
            new Headers(init.headers).get("authorization"),
            `Bearer ${TOKEN}`,
        );
        assert.equal(
            new Headers(init.headers).get("content-type"),
            "application/json",
        );
        const body = JSON.parse(init.body);
        assert.deepEqual(body, {
            model: "openai",
            max_tokens: 200,
            messages: [
                {
                    role: "system",
                    content:
                        "You are a precise visual assistant. Answer only from what is visible " +
                        "in the images. When something is not visible or unclear, say so " +
                        "instead of guessing.",
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: "https://example.com/cat.jpg",
                                detail: "high",
                            },
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: "https://example.com/dog.jpg",
                                detail: "high",
                            },
                        },
                        { type: "text", text: "Which animal is taller?" },
                    ],
                },
            ],
        });
        return visionResponse("The dog is taller.");
    });
    const client = await connectClient({
        versionNegotiation: { mode: "auto" },
    });
    t.after(() => client.close());
    const result = await client.callTool({
        name: "look",
        arguments: {
            images: [
                "https://example.com/cat.jpg",
                "https://example.com/dog.jpg",
            ],
            question: "Which animal is taller?",
            detail: "high",
            max_tokens: 200,
        },
    });
    assert.notEqual(result.isError, true);
    assert.equal(calls, 1);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, "The dog is taller.");
    assert.deepEqual(JSON.parse(result.content[1].text).usage, {
        prompt_tokens: 650,
        completion_tokens: 40,
        total_tokens: 690,
    });
});

test("defaults to a detailed description when no question is given", async (t) => {
    let textPart;
    t.mock.method(globalThis, "fetch", async (_input, init) => {
        const body = JSON.parse(init.body);
        const content = body.messages[1].content;
        textPart = content[content.length - 1];
        return visionResponse("A cat on a windowsill.");
    });
    const client = await connectClient();
    t.after(() => client.close());
    const result = await client.callTool({
        name: "look",
        arguments: { images: ["https://example.com/cat.jpg"] },
    });
    assert.notEqual(result.isError, true);
    assert.equal(textPart.type, "text");
    assert.match(textPart.text, /^Describe the image in detail/);
    assert.equal(result.content[0].text, "A cat on a windowsill.");
});

test("describes several images together when no question is given", async (t) => {
    let textPart;
    t.mock.method(globalThis, "fetch", async (_input, init) => {
        const body = JSON.parse(init.body);
        const content = body.messages[1].content;
        textPart = content[content.length - 1];
        return visionResponse("Two cats, one asleep and one awake.");
    });
    const client = await connectClient();
    t.after(() => client.close());
    const result = await client.callTool({
        name: "look",
        arguments: {
            images: [
                "https://example.com/cat-1.jpg",
                "https://example.com/cat-2.jpg",
            ],
        },
    });
    assert.notEqual(result.isError, true);
    assert.match(textPart.text, /^Describe each image in detail/);
});

test("reads visible text with read_image_text", async (t) => {
    let body;
    t.mock.method(globalThis, "fetch", async (_input, init) => {
        body = JSON.parse(init.body);
        return visionResponse("OPEN 9–17\nClosed Mondays");
    });
    const client = await connectClient();
    t.after(() => client.close());
    const result = await client.callTool({
        name: "read_image_text",
        arguments: { image: "https://example.com/sign.jpg", detail: "low" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].text, "OPEN 9–17\nClosed Mondays");
    const content = body.messages[1].content;
    assert.equal(content[0].image_url.url, "https://example.com/sign.jpg");
    assert.equal(content[0].image_url.detail, "low");
    assert.equal(content.length, 2);
    assert.match(content[1].text, /^Extract all text visible in this image/);
});

test("rejects bad arguments before fetching", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => {
        throw new Error("Unexpected fetch for invalid arguments");
    });
    const client = await connectClient({
        versionNegotiation: { mode: "auto" },
    });
    t.after(() => client.close());
    for (const arguments_ of [
        {},
        { images: [] },
        { images: ["https://example.com/a.jpg", ""] },
        { images: ["https://example.com/a.jpg"], question: "" },
        { image: "https://example.com/a.jpg", detail: "medium" },
        { image: "https://example.com/a.jpg", max_tokens: 0 },
    ]) {
        const result = await client.callTool({
            name: Object.hasOwn(arguments_, "image")
                ? "read_image_text"
                : "look",
            arguments: arguments_,
        });
        assert.equal(result.isError, true, JSON.stringify(arguments_));
    }
    assert.equal(fetchMock.mock.callCount(), 0);
});

test("uses shared gateway error mapping", async (t) => {
    t.mock.method(globalThis, "fetch", async (input) => {
        assert.equal(
            String(input),
            "https://gen.pollinations.ai/v1/chat/completions",
        );
        return Response.json(
            { error: { message: "Insufficient balance" } },
            { status: 402 },
        );
    });
    const client = await connectClient({
        versionNegotiation: { mode: "auto" },
    });
    t.after(() => client.close());
    const result = await client.callTool({
        name: "look",
        arguments: { images: ["https://example.com/cat.jpg"] },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Insufficient balance/);
});

test("fails clearly when the model returns no answer", async (t) => {
    t.mock.method(globalThis, "fetch", async () => visionResponse(""));
    const client = await connectClient();
    t.after(() => client.close());
    const result = await client.callTool({
        name: "look",
        arguments: { images: ["https://example.com/cat.jpg"] },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no answer/i);
});

test("keeps bearer tokens scoped to concurrent requests", async (t) => {
    const seenAuthorizations = new Set();
    t.mock.method(globalThis, "fetch", async (_input, init) => {
        const authorization = new Headers(init.headers).get("authorization");
        seenAuthorizations.add(authorization);
        return visionResponse(
            authorization === "Bearer pk_first" ? "First key." : "Second key.",
        );
    });
    const options = { versionNegotiation: { mode: "auto" } };
    const firstClient = await connectClient(options, "pk_first");
    const secondClient = await connectClient(options, "sk_second");
    t.after(() => Promise.all([firstClient.close(), secondClient.close()]));
    const request = {
        name: "look",
        arguments: { images: ["https://example.com/cat.jpg"] },
    };
    const [first, second] = await Promise.all([
        firstClient.callTool(request),
        secondClient.callTool(request),
    ]);
    assert.equal(first.content[0].text, "First key.");
    assert.equal(second.content[0].text, "Second key.");
    assert.deepEqual(
        seenAuthorizations,
        new Set(["Bearer pk_first", "Bearer sk_second"]),
    );
});
