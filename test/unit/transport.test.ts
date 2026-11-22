import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { Transport, AcpTransportClosed } from "../../src/acp/transport.js";

describe("Transport", () => {
  it("sends a JSON-RPC request and resolves matching response", async () => {
    // A fake child process echoing response to request id 1
    const child = spawn("node", [
      "-e",
      `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { greeted: msg.params.name } }) + "\\n");
      });
      `,
    ]);

    const transport = new Transport(child);
    const res = await transport.request("hello", { name: "Antigravity" });
    expect(res).toEqual({ greeted: "Antigravity" });

    transport.close();
  });

  it("routes incoming notifications to onNotify handler", async () => {
    const onNotify = vi.fn();
    const child = spawn("node", [
      "-e",
      `
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { chunk: "abc" } }) + "\\n");
      setTimeout(() => {}, 200);
      `,
    ]);

    const transport = new Transport(child, onNotify);
    await vi.waitFor(() => expect(onNotify).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(onNotify).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "session/update",
      params: { chunk: "abc" },
    });

    transport.close();
  });

  it("handles concurrent requests without cross-talk", async () => {
    const child = spawn("node", [
      "-e",
      `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        const delay = msg.params.delay;
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { delay } }) + "\\n");
        }, delay);
      });
      `,
    ]);

    const transport = new Transport(child);
    const [p1, p2] = await Promise.all([
      transport.request("wait", { delay: 40 }),
      transport.request("wait", { delay: 10 }),
    ]);

    expect(p1).toEqual({ delay: 40 });
    expect(p2).toEqual({ delay: 10 });

    transport.close();
  });

  it("rejects pending requests when child process exits", async () => {
    const child = spawn("node", [
      "-e",
      `
      setTimeout(() => process.exit(1), 50);
      `,
    ]);

    const transport = new Transport(child);
    await expect(transport.request("slow_method", {})).rejects.toThrow(
      AcpTransportClosed
    );
  });
});
