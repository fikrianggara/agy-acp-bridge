import * as net from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { ContinuationStore } from "./continuation.js";
import { McpToolDefinition, McpToolCallParams } from "./types.js";
import { OpenAITool } from "../mapping/request.js";

export interface PendingToolCallEvent {
  callId: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export class McpBridgeServer extends EventEmitter {
  private server: net.Server | null = null;
  private port: number = 0;
  private sessionTools = new Map<string, McpToolDefinition[]>();
  private defaultTools: McpToolDefinition[] = [];
  public readonly continuationStore: ContinuationStore;

  constructor(continuationStore?: ContinuationStore) {
    super();
    this.continuationStore = continuationStore || new ContinuationStore();
  }

  public async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", reject);

      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error("Failed to get server port"));
        }
      });
    });
  }

  public getPort(): number {
    return this.port;
  }

  public setSessionTools(sessionId: string, tools: OpenAITool[]): void {
    const mcpTools: McpToolDefinition[] = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: (t.function.parameters as Record<string, unknown>) || {
        type: "object",
        properties: {},
      },
    }));
    this.sessionTools.set(sessionId, mcpTools);
  }

  public setDefaultTools(tools: OpenAITool[]): void {
    this.defaultTools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: (t.function.parameters as Record<string, unknown>) || {
        type: "object",
        properties: {},
      },
    }));
  }

  public getKnownToolNames(sessionId?: string): string[] {
    const tools = sessionId
      ? this.sessionTools.get(sessionId) || this.defaultTools
      : this.defaultTools;
    return tools.map((t) => t.name);
  }

  public async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          this.handleRpc(socket, msg);
        } catch {
          // ignore malformed lines
        }
      }
    });
  }

  private handleRpc(socket: net.Socket, msg: any): void {
    const id = msg.id;
    const method = msg.method;

    if (id === undefined && method) {
      // Notifications (e.g. notifications/initialized)
      return;
    }

    if (method === "server/discover" || method === "initialize") {
      this.send(socket, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {
            tools: {
              listChanged: true,
            },
          },
          serverInfo: {
            name: "openai-acp-bridge",
            version: "0.1.0",
          },
        },
      });
      return;
    }

    if (method === "tools/list") {
      const sessionId = msg.params?._meta?.["antigravity.google/conversation_id"];
      const tools = sessionId
        ? this.sessionTools.get(sessionId) || this.defaultTools
        : this.defaultTools;
      this.send(socket, {
        jsonrpc: "2.0",
        id,
        result: {
          tools,
        },
      });
      return;
    }

    if (method === "tools/call") {
      const params = msg.params as McpToolCallParams;
      const toolName = params.name;
      const args = params.arguments || {};
      const sessionId =
        params._meta?.["antigravity.google/conversation_id"] || "default";

      const callId = `call_${crypto.randomUUID().slice(0, 8)}`;

      this.continuationStore.create(
        callId,
        sessionId,
        id,
        toolName,
        args,
        (result) => {
          this.send(socket, {
            jsonrpc: "2.0",
            id,
            result,
          });
        },
        (error) => {
          this.send(socket, {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: error.message,
            },
          });
        }
      );

      this.emit("tool_call", {
        callId,
        sessionId,
        toolName,
        arguments: args,
      } as PendingToolCallEvent);
      return;
    }

    // Default: unsupported method
    this.send(socket, {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  }

  private send(socket: net.Socket, obj: any): void {
    if (socket.writable) {
      socket.write(JSON.stringify(obj) + "\n");
    }
  }
}
