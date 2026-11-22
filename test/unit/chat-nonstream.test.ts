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

describe("Non-stream Chat Completions", () => {
  let child: ChildProcessWithoutNullStreams;
  let transport: Transport;
  let connection: Connection;
  let modelService: ModelService;

  beforeEach(async () => {
    child = spawn("pnpm", ["tsx", fakeAgentPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
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

  it("handles valid non-stream chat completion request", async () => {
    const config = parseConfig({});
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hello there" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toContain("Hello! I am fake agy.");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(150);
    expect(body.usage.completion_tokens).toBe(25);
  });

  it("returns 400 model_not_found for unknown model", async () => {
    const config = parseConfig({});
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "non-existent-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("model_not_found");
  });

  it("returns 400 unsupported_option when x-acp-thought-level is not in options", async () => {
    const config = parseConfig({});
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acp-thought-level": "max", // fake-agent only offers low, medium, high
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("unsupported_option");
  });

  it("returns 200 with x-acp-warnings when temperature is sent", async () => {
    const config = parseConfig({});
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.7,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-acp-warnings")).toContain("temperature");
  });

  it("enforces allowed roots for x-acp-cwd", async () => {
    const config = parseConfig({
      allowRoots: ["/Users/fikrianggara/projects"],
    });
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acp-cwd": "/etc/sensitive",
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("cwd_not_allowed");
  });
});
