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

describe("Security Middleware", () => {
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

  it("rejects unauthorized requests with 401", async () => {
    const config = parseConfig({ authToken: "expected-secret-token" });
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);

    const resInvalid = await app.request("/v1/models", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(resInvalid.status).toBe(401);
  });

  it("blocks requests with cwd outside allowRoots with 403", async () => {
    const config = parseConfig({
      allowRoots: ["/Users/fikrianggara/projects"],
    });
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acp-cwd": "/private/etc",
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
