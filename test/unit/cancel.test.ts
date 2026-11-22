import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Transport } from "../../src/acp/transport.js";
import { Connection } from "../../src/acp/connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.resolve(__dirname, "../../scripts/fake-agent.ts");

describe("Cancel and Disconnect", () => {
  let child: ChildProcessWithoutNullStreams;
  let transport: Transport;
  let connection: Connection;

  beforeEach(async () => {
    child = spawn("pnpm", ["tsx", fakeAgentPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FAKE_SCENARIO: "slow" },
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

  it("sends session/cancel notification without throwing", async () => {
    const session = await connection.newSession({ cwd: process.cwd() });
    expect(() => connection.cancel(session.sessionId)).not.toThrow();
  });
});
