import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import { McpBridgeServer } from "../../src/mcp/server.js";
import { ContinuationStore } from "../../src/mcp/continuation.js";

describe("MCP Tool Bridge", () => {
  let mcpServer: McpBridgeServer;
  let port: number;

  beforeEach(async () => {
    mcpServer = new McpBridgeServer();
    port = await mcpServer.start(0);
  });

  afterEach(async () => {
    await mcpServer.close();
  });

  it("completes MCP initialize handshake over TCP", async () => {
    const client = net.createConnection({ port, host: "127.0.0.1" });
    const responses: any[] = [];

    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          responses.push(JSON.parse(line.trim()));
          if (responses.length >= 2) {
            resolve();
          }
        }
      });
      client.on("error", reject);

      // Send discover
      client.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {},
        }) + "\n"
      );

      // Send initialize
      client.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }) + "\n"
      );
    });

    client.destroy();

    expect(responses.length).toBe(2);
    expect(responses[0].id).toBe(1);
    expect(responses[0].result.capabilities.tools).toBeDefined();
    expect(responses[1].id).toBe(2);
    expect(responses[1].result.serverInfo.name).toBe("openai-acp-bridge");
  });

  it("lists registered tools via tools/list", async () => {
    mcpServer.setDefaultTools([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ]);

    const client = net.createConnection({ port, host: "127.0.0.1" });
    let listResponse: any;

    await new Promise<void>((resolve, reject) => {
      client.on("data", (data) => {
        listResponse = JSON.parse(data.toString("utf-8").trim());
        resolve();
      });
      client.on("error", reject);

      client.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/list",
          params: {},
        }) + "\n"
      );
    });

    client.destroy();

    expect(listResponse.id).toBe(10);
    expect(listResponse.result.tools.length).toBe(1);
    expect(listResponse.result.tools[0].name).toBe("get_weather");
    expect(listResponse.result.tools[0].inputSchema.properties.city).toBeDefined();
  });

  it("intercepts tools/call, creates continuation, and resolves when tool output arrives", async () => {
    let capturedEvent: any;
    mcpServer.on("tool_call", (e) => {
      capturedEvent = e;
    });

    const client = net.createConnection({ port, host: "127.0.0.1" });
    let toolResultResponse: any;

    const callPromise = new Promise<void>((resolve, reject) => {
      client.on("data", (data) => {
        toolResultResponse = JSON.parse(data.toString("utf-8").trim());
        resolve();
      });
      client.on("error", reject);

      // Trigger tools/call
      client.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: {
            name: "calculate_tax",
            arguments: { amount: 1000 },
            _meta: {
              "antigravity.google/conversation_id": "sess-xyz",
            },
          },
        }) + "\n"
      );
    });

    // Wait for tool_call event to be emitted
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent.toolName).toBe("calculate_tax");
    expect(capturedEvent.arguments).toEqual({ amount: 1000 });
    expect(capturedEvent.callId).toMatch(/^call_/);

    // Verify continuation is pending
    const continuation = mcpServer.continuationStore.get(capturedEvent.callId);
    expect(continuation).toBeDefined();

    // Now resolve the continuation (simulating harness providing tool output)
    continuation?.resolve({
      content: [{ type: "text", text: JSON.stringify({ tax: 100 }) }],
    });

    await callPromise;
    client.destroy();

    expect(toolResultResponse.id).toBe(42);
    expect(toolResultResponse.result.content[0].text).toContain("100");
  });

  it("handles continuation TTL expiration", () => {
    const store = new ContinuationStore(10); // 10ms TTL
    let rejectedError: Error | null = null;

    store.create(
      "call-exp",
      "sess-1",
      1,
      "test_tool",
      {},
      () => {},
      (err) => {
        rejectedError = err;
      }
    );

    // Immediately available
    expect(store.get("call-exp")).toBeDefined();

    // Wait for TTL to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const item = store.get("call-exp");
        expect(item).toBeUndefined();
        expect(rejectedError).toBeDefined();
        expect(rejectedError?.message).toContain("timed out");
        resolve();
      }, 30);
    });
  });
});
