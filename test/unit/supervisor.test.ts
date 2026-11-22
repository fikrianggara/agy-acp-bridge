import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "../../src/acp/supervisor.js";
import { parseConfig } from "../../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.resolve(__dirname, "../../scripts/fake-agent.ts");

describe("Supervisor", () => {
  let supervisor: Supervisor;

  afterEach(async () => {
    if (supervisor) {
      await supervisor.shutdown();
    }
  });

  it("starts fake-agent, initializes handshake, and reports ready", async () => {
    const config = parseConfig({});
    supervisor = new Supervisor(config, "pnpm", ["tsx", fakeAgentPath]);
    await supervisor.start();

    expect(supervisor.isReady()).toBe(true);
    expect(supervisor.connection).toBeDefined();
  });

  it("handles permission requests sent by the agent during prompt", async () => {
    const config = parseConfig({ permissionPolicy: "deny" });
    // In scenario 'permission', fake agent sends session/request_permission during prompt
    supervisor = new Supervisor(config, "pnpm", [
      "tsx",
      fakeAgentPath,
    ]);
    process.env.FAKE_SCENARIO = "permission";
    await supervisor.start();

    const session = await supervisor.connection.newSession({ cwd: process.cwd() });
    await supervisor.connection.prompt(session.sessionId, "Test permission");

    const logs = supervisor.permissionEngine.getAuditLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].policy).toBe("deny");
    expect(logs[0].outcome).toBe("selected");

    delete process.env.FAKE_SCENARIO;
  });
});
