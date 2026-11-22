import { OpenAITool } from "../mapping/request.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: {
    "antigravity.google/conversation_id"?: string;
    [key: string]: unknown;
  };
}

export interface Continuation {
  callId: string;
  sessionId: string;
  rpcId: number | string;
  toolName: string;
  arguments: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  resolve: (result: { content: Array<{ type: "text"; text: string }> }) => void;
  reject: (err: Error) => void;
  attachStream?: (cb: (chunk: any) => void) => void;
  promptPromise?: Promise<any>;
}
