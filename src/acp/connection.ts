import { Transport, AcpRpcError } from "./transport.js";
import {
  AcpAuthError,
  AcpTimeoutError,
  InitializeResult,
  InitializeResultSchema,
  SessionNewResult,
  SessionNewResultSchema,
  SessionPromptResult,
  SessionPromptResultSchema,
  PromptChunkCallback,
} from "./types.js";

export class Connection {
  private activeStreams = new Map<string, PromptChunkCallback>();

  constructor(
    private readonly transport: Transport,
    private readonly defaultTimeoutMs = 10_000
  ) {}

  public handleNotification(method: string, params?: unknown): void {
    if (method === "session/update" && params && typeof params === "object") {
      const p = params as { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } };
      const sessionId = p.sessionId;
      if (!sessionId) return;

      const cb = this.activeStreams.get(sessionId);
      if (!cb) return;

      const update = p.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
        cb({ type: "text", text: update.content.text });
      } else if (update?.sessionUpdate === "agent_thought_chunk" && update.content?.text) {
        cb({ type: "thought", text: update.content.text });
      }
    }
  }

  public async initialize(
    clientInfo = { name: "openai-acp-bridge", version: "0.1.0" },
    timeoutMs = this.defaultTimeoutMs
  ): Promise<InitializeResult> {
    try {
      const res = await this.withTimeout(
        this.transport.request("initialize", {
          protocolVersion: 1,
          clientInfo,
          clientCapabilities: {
            fs: false,
            terminal: false,
          },
        }),
        timeoutMs,
        "initialize"
      );
      return InitializeResultSchema.parse(res);
    } catch (err) {
      this.handleRpcError(err);
      throw err;
    }
  }

  public async newSession(
    params: {
      cwd: string;
      systemPrompt?: { mode: "append" | "replace"; value: string };
    },
    timeoutMs = this.defaultTimeoutMs
  ): Promise<SessionNewResult> {
    try {
      const res = await this.withTimeout(
        this.transport.request("session/new", {
          cwd: params.cwd,
          ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        }),
        timeoutMs,
        "session/new"
      );
      return SessionNewResultSchema.parse(res);
    } catch (err) {
      this.handleRpcError(err);
      throw err;
    }
  }

  public async loadSession(
    sessionId: string,
    cwd: string,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<SessionNewResult> {
    try {
      const res = await this.withTimeout(
        this.transport.request("session/load", {
          sessionId,
          cwd,
        }),
        timeoutMs,
        "session/load"
      );
      return SessionNewResultSchema.parse(res);
    } catch (err) {
      this.handleRpcError(err);
      throw err;
    }
  }

  public async setConfigOption(
    sessionId: string,
    category: string,
    value: string,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<void> {
    try {
      await this.withTimeout(
        this.transport.request("session/set_config_option", {
          sessionId,
          configId: category,
          value,
        }),
        timeoutMs,
        "session/set_config_option"
      );
    } catch (err) {
      this.handleRpcError(err);
      throw err;
    }
  }

  public async prompt(
    sessionId: string,
    promptText: string,
    onChunk?: PromptChunkCallback,
    timeoutMs = 300_000
  ): Promise<SessionPromptResult> {
    if (onChunk) {
      this.activeStreams.set(sessionId, onChunk);
    }

    try {
      const res = await this.withTimeout(
        this.transport.request("session/prompt", {
          sessionId,
          prompt: [
            {
              type: "text",
              text: promptText,
            },
          ],
        }),
        timeoutMs,
        "session/prompt"
      );
      return SessionPromptResultSchema.parse(res);
    } catch (err) {
      this.handleRpcError(err);
      throw err;
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }

  public cancel(sessionId: string): void {
    this.transport.notify("session/cancel", { sessionId });
  }

  public async closeSession(
    sessionId: string,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<void> {
    try {
      await this.withTimeout(
        this.transport.request("session/close", { sessionId }),
        timeoutMs,
        "session/close"
      );
    } catch (err) {
      this.handleRpcError(err);
      throw err;
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }

  private handleRpcError(err: unknown): void {
    if (err instanceof AcpRpcError && err.code === -32000) {
      throw new AcpAuthError(err.message);
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AcpTimeoutError(
            `Operation '${operationName}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      timer.unref?.();
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }
}
