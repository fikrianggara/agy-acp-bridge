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

describe("Models Endpoint & App Probes", () => {
  let child: ChildProcessWithoutNullStreams;
  let transport: Transport;
  let connection: Connection;

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
  });

  afterEach(() => {
    transport?.close();
    child?.kill("SIGTERM");
  });

  it("returns list of models in OpenAI format", async () => {
    const config = parseConfig({});
    const modelService = new ModelService(connection);
    const app = createApp({ config, connection, modelService });

    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBe(2);
    expect(body.data[0].id).toBe("gemini-3.8-flash");
    expect(body.data[0].object).toBe("model");
    expect(body.data[0].owned_by).toBe("antigravity");
  });

  it("caches models across subsequent requests", async () => {
    const modelService = new ModelService(connection);
    const m1 = await modelService.getModels();
    const m2 = await modelService.getModels();
    expect(m1).toBe(m2); // Same object reference due to cache
  });

  it("enforces bearer auth if authToken is configured", async () => {
    const config = parseConfig({ authToken: "secret-key-123" });
    const modelService = new ModelService(connection);
    const app = createApp({ config, connection, modelService });

    const unauthedRes = await app.request("/v1/models");
    expect(unauthedRes.status).toBe(401);

    const authedRes = await app.request("/v1/models", {
      headers: { Authorization: "Bearer secret-key-123" },
    });
    expect(authedRes.status).toBe(200);
  });

  it("serves healthz and readyz probes", async () => {
    const config = parseConfig({});
    const modelService = new ModelService(connection);
    let readyState = true;
    const app = createApp({
      config,
      connection,
      modelService,
      isReady: () => readyState,
    });

    const healthRes = await app.request("/healthz");
    expect(healthRes.status).toBe(200);

    const readyRes = await app.request("/readyz");
    expect(readyRes.status).toBe(200);

    readyState = false;
    const unreadyRes = await app.request("/readyz");
    expect(unreadyRes.status).toBe(503);
  });
});
