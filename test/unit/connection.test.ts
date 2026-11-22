import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Transport } from "../../src/acp/transport.js";
import { Connection } from "../../src/acp/connection.js";
import { AcpAuthError, AcpTimeoutError } from "../../src/acp/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.resolve(__dirname, "../../scripts/fake-agent.ts");

describe("Connection Layer", () => {
  let child: ChildProcessWithoutNullStreams;
  let transport: Transport;
  let connection: Connection;

  function spawnAgent(env: NodeJS.ProcessEnv = {}) {
    child = spawn("pnpm", ["tsx", fakeAgentPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    transport = new Transport(child, (notif) => {
      connection.handleNotification(notif.method, notif.params);
    });
    connection = new Connection(transport, 5000);
  }

  afterEach(() => {
    transport?.close();
    child?.kill("SIGTERM");
  });

  it("initializes successfully against fake agent", async () => {
    spawnAgent();
    const res = await connection.initialize();
    expect(res.protocolVersion).toBe(1);
    expect(res.agentInfo?.name).toBe("fake-agy");
    expect(res.models?.availableModels).toHaveLength(2);
  });

  it("creates a new session and returns config options", async () => {
    spawnAgent();
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    expect(session.sessionId).toMatch(/^fake-session-/);
    expect(session.configOptions.length).toBeGreaterThan(0);
    const modelOpt = session.configOptions.find((o) => o.category === "model");
    expect(modelOpt?.currentValue).toBe("gemini-3.8-flash");
  });

  it("sets a config option successfully", async () => {
    spawnAgent();
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });
    await expect(
      connection.setConfigOption(session.sessionId, "model", "gemini-3.8-pro")
    ).resolves.not.toThrow();
  });

  it("prompts, collects chunks, and returns stopReason with usage", async () => {
    spawnAgent();
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });

    const chunks: string[] = [];
    const promptRes = await connection.prompt(
      session.sessionId,
      "Hello test",
      (chunk) => {
        if (chunk.type === "text") chunks.push(chunk.text);
      }
    );

    expect(chunks.join("")).toContain("Hello! I am fake agy.");
    expect(promptRes.stopReason).toBe("end_turn");
    expect(promptRes.usage?.inputTokens).toBe(150);
    expect(promptRes.usage?.outputTokens).toBe(25);
  });

  it("maps -32000 error to AcpAuthError", async () => {
    spawnAgent({ FAKE_SCENARIO: "authfail" });
    await expect(connection.initialize()).rejects.toThrow(AcpAuthError);
  });

  it("times out when agent does not respond within timeout", async () => {
    spawnAgent({ FAKE_SCENARIO: "slow" });
    await connection.initialize();
    const session = await connection.newSession({ cwd: process.cwd() });

    // Request prompt with very small timeout (50ms) while fake-agent sleeps 500ms
    await expect(
      connection.prompt(session.sessionId, "Hello test", undefined, 50)
    ).rejects.toThrow(AcpTimeoutError);
  });
});
