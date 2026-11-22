import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Transport } from "../../src/acp/transport.js";
import { Connection } from "../../src/acp/connection.js";
import { parseConfig } from "../../src/config.js";
import { ModelService } from "../../src/http/models.js";
import { createApp } from "../../src/http/app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.resolve(__dirname, "../../scripts/fake-agent.ts");

describe("Stream Chat Completions (SSE)", () => {
  let child: ChildProcessWithoutNullStreams;
  let transport: Transport;
  let connection: Connection;
  let modelService: ModelService;

  beforeEach(async () => {
    child = spawn("pnpm", ["tsx", fakeAgentPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, EMIT_THOUGHTS: "1" },
    });
    transport = new Transport(child, (notif) => {
      connection.handleNotification(notif.method, notif.params);
    });
    connection = new Connection(transport, 5000);
    await connection.initialize();
    modelService = new ModelService(connection);
  });

  afterEach(() => {
    transport?.close();
    child?.kill("SIGTERM");
  });

  it("streams SSE chunks in standard OpenAI format ending with [DONE]", async () => {
    const config = parseConfig({ exposeThoughts: false });
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hello stream" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: [DONE]");

    const lines = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");

    const chunks = lines.map((line) => JSON.parse(line.slice(6)));
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // Chunk 0: role assistant
    expect(chunks[0].choices[0].delta.role).toBe("assistant");

    // Middle chunk: content text
    const contentChunks = chunks.filter((c) => c.choices[0].delta.content);
    expect(contentChunks.length).toBeGreaterThan(0);
    const fullContent = contentChunks
      .map((c) => c.choices[0].delta.content)
      .join("");
    expect(fullContent).toContain("Hello! I am fake agy.");

    // Final chunk: finish_reason
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0].finish_reason).toBe("stop");
  });

  it("includes usage in final chunk when stream_options.include_usage is true", async () => {
    const config = parseConfig({});
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hello stream" }],
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }),
    });

    const text = await res.text();
    const lines = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");

    const chunks = lines.map((line) => JSON.parse(line.slice(6)));
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.usage).toBeDefined();
    expect(lastChunk.usage.prompt_tokens).toBe(150);
    expect(lastChunk.usage.completion_tokens).toBe(25);
  });

  it("exposes thoughts as reasoning_content when exposeThoughts is true", async () => {
    const config = parseConfig({ exposeThoughts: true });
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hello stream" }],
        stream: true,
      }),
    });

    const text = await res.text();
    const lines = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]");

    const chunks = lines.map((line) => JSON.parse(line.slice(6)));
    const thoughtChunks = chunks.filter(
      (c) => c.choices[0].delta.reasoning_content
    );
    expect(thoughtChunks.length).toBeGreaterThan(0);
    expect(thoughtChunks[0].choices[0].delta.reasoning_content).toContain(
      "Thinking about hello..."
    );
  });
});
