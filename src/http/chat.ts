import { Hono } from "hono";
import crypto from "node:crypto";
import { Connection } from "../acp/connection.js";
import { Config } from "../config.js";
import { ModelService } from "./models.js";
import {
  ChatCompletionRequestSchema,
  getUnsupportedWarnings,
  formatSystemContext,
  stringifyMessageContent,
  OpenAITool,
} from "../mapping/request.js";
import { mapFinishReason } from "../mapping/finish.js";
import { handleStreamCompletion } from "./sse.js";
import {
  SessionStore,
  computeKey,
  Conversation,
} from "../sessions/store.js";
import {
  reconcile,
  computeMessagesDigest,
  computeSystemHash,
} from "../sessions/reconcile.js";
import { KeyedLock } from "../sessions/lock.js";
import { McpBridgeServer, PendingToolCallEvent } from "../mcp/server.js";

export function createChatRouter(
  connection: Connection,
  modelService: ModelService,
  config: Config,
  sessionStore: SessionStore,
  lock: KeyedLock,
  mcpServer?: McpBridgeServer
): Hono {
  const router = new Hono();

  router.post("/chat/completions", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
          },
        },
        400
      );
    }

    const parseResult = ChatCompletionRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message: parseResult.error.issues.map((i) => i.message).join("; "),
            type: "invalid_request_error",
          },
        },
        400
      );
    }

    const req = parseResult.data;

    if (req.n && req.n > 1) {
      return c.json(
        {
          error: {
            message: "n > 1 is not supported by ACP bridge",
            type: "invalid_request_error",
          },
        },
        400
      );
    }

    // Check CWD against ALLOW_ROOTS
    const headerCwd = c.req.header("x-acp-cwd");
    const cwd = headerCwd || process.cwd();
    if (headerCwd && config.allowRoots.length > 0) {
      const allowed = config.allowRoots.some((root) => cwd.startsWith(root));
      if (!allowed) {
        return c.json(
          {
            error: {
              message: `Requested cwd '${cwd}' is not in allowed roots: ${config.allowRoots.join(", ")}`,
              type: "cwd_not_allowed",
            },
          },
          403
        );
      }
    }

    // Validate Model
    const availableModels = await modelService.getModels();
    const isModelValid = availableModels.some((m) => m.id === req.model);
    if (!isModelValid) {
      return c.json(
        {
          error: {
            message: `Model '${req.model}' not found. Available models: ${availableModels.map((m) => m.id).join(", ")}`,
            type: "model_not_found",
          },
        },
        400
      );
    }

    // Determine principal and conversation ID
    const principalId = "default";
    let conversationId = c.req.header("x-acp-conversation") || req.user;
    if (!conversationId) {
      // Fallback: sha256 hash of first message
      const firstMsg = req.messages[0];
      conversationId = crypto
        .createHash("sha256")
        .update(`${firstMsg.role}:${stringifyMessageContent(firstMsg.content)}`)
        .digest("hex");
    }

    const key = computeKey(principalId, conversationId);

    // Acquire lock
    if (!lock.tryAcquire(key)) {
      return c.json(
        {
          error: {
            message: "Session is busy with another turn",
            type: "session_busy",
          },
        },
        409
      );
    }

    try {
      const existingConv = sessionStore.get(key);

      // Reconcile
      let rec;
      try {
        rec = reconcile(existingConv, req.messages, req.model);
      } catch (err: any) {
        if (err.name === "SessionBusyError") {
          return c.json(
            {
              error: {
                message: "Session is busy with another turn",
                type: "session_busy",
              },
            },
            409
          );
        }
        throw err;
      }

      let acpSessionId: string;
      let promptText: string;

      if (rec.kind === "delta" && existingConv) {
        // FAST PATH: Re-use existing ACP session
        acpSessionId = existingConv.acpSessionId;
        promptText = rec.promptText;
      } else {
        // FULL REPLAY / NEW SESSION
        if (existingConv?.acpSessionId) {
          connection.closeSession(existingConv.acpSessionId).catch(() => {});
        }

        const session = await connection.newSession({ cwd });
        acpSessionId = session.sessionId;

        // Set model
        await connection.setConfigOption(acpSessionId, "model", req.model);

        // Thought level
        const thoughtHeader = c.req.header("x-acp-thought-level");
        if (thoughtHeader) {
          const thoughtOpt = session.configOptions.find(
            (o) => o.category === "thought_level"
          );
          const validValues = thoughtOpt?.options.map((o) => o.value) ?? [];
          if (!validValues.includes(thoughtHeader)) {
            await connection.closeSession(acpSessionId).catch(() => {});
            return c.json(
              {
                error: {
                  message: `Unsupported thought level '${thoughtHeader}'. Valid options: ${validValues.join(", ")}`,
                  type: "unsupported_option",
                },
              },
              400
            );
          }
          await connection.setConfigOption(
            acpSessionId,
            "thought_level",
            thoughtHeader
          );
        }

        // Mode
        const modeHeader = c.req.header("x-acp-mode");
        if (modeHeader) {
          await connection.setConfigOption(acpSessionId, "mode", modeHeader);
        }

        // Format prompt with prefix context (memory & skills)
        const systemMessages = req.messages.filter((m) => m.role === "system");
        const nonSystemMessages = req.messages.filter((m) => m.role !== "system");
        const systemPrefix = formatSystemContext(systemMessages);

        if (nonSystemMessages.length <= 1) {
          const lastMsg = nonSystemMessages[0] || { content: "" };
          promptText = systemPrefix + stringifyMessageContent(lastMsg.content);
        } else {
          const historyLines = nonSystemMessages.slice(0, -1).map((m) => {
            return `${m.role.toUpperCase()}:\n${stringifyMessageContent(m.content)}`;
          });
          const lastMsg = nonSystemMessages[nonSystemMessages.length - 1];
          promptText = [
            systemPrefix,
            "[Conversation History]",
            ...historyLines,
            "[End Conversation History]",
            "",
            stringifyMessageContent(lastMsg.content),
          ].join("\n");
        }
      }

      // Register tools if provided
      if (req.tools && req.tools.length > 0 && mcpServer) {
        mcpServer.setSessionTools(acpSessionId, req.tools as OpenAITool[]);
        mcpServer.setDefaultTools(req.tools as OpenAITool[]);
      }

      // Check if fulfilling a tool continuation
      const lastMsg = req.messages[req.messages.length - 1];
      const isToolResolution = lastMsg?.role === "tool" && lastMsg.tool_call_id && mcpServer;
      const activeContinuation = isToolResolution ? mcpServer?.continuationStore.get(lastMsg.tool_call_id!) : undefined;

      if (activeContinuation) {
        activeContinuation.resolve({
          content: [{ type: "text", text: String(lastMsg.content || "") }],
        });
        mcpServer?.continuationStore.delete(lastMsg.tool_call_id!);
      }

      // Add headers
      const warnings = getUnsupportedWarnings(req, { mcpBridgeEnabled: !!mcpServer });
      if (warnings.length > 0) {
        c.header("x-acp-warnings", warnings.join(", "));
      }
      c.header("x-acp-session-id", acpSessionId);

      // Track turn state
      const turnId = `turn-${Date.now()}`;
      const activeTurnState = { turnId, startedAt: Date.now() };

      const currentConv: Conversation = {
        key,
        principalId,
        conversationId,
        acpSessionId,
        cwd,
        model: req.model,
        systemHash: computeSystemHash(req.messages),
        messagesDigest: computeMessagesDigest(req.messages),
        messagesCount: req.messages.length,
        lastAssistantText: existingConv?.lastAssistantText || "",
        createdAt: existingConv?.createdAt || Date.now(),
        lastUsedAt: Date.now(),
        activeTurn: activeTurnState,
      };
      sessionStore.set(currentConv);

      const finalizeSession = (assistantText: string) => {
        const stored = sessionStore.get(key);
        if (stored) {
          stored.lastAssistantText = assistantText;
          stored.lastUsedAt = Date.now();
          stored.activeTurn = null;
          stored.messagesCount = req.messages.length;
          stored.messagesDigest = computeMessagesDigest(req.messages);
          sessionStore.set(stored);
        }
      };

      // Stream handling
      if (req.stream) {
        let streamAssistantText = "";
        return handleStreamCompletion(c, {
          connection,
          sessionId: acpSessionId,
          model: req.model,
          promptText,
          includeUsage: req.stream_options?.include_usage ?? false,
          exposeThoughts: config.exposeThoughts,
          mcpServer,
          continuation: activeContinuation,
          onEnd: () => {
            finalizeSession(streamAssistantText);
            lock.release(key);
          },
        });
      }

      // Non-stream handling
      const interceptedToolCallRef: { current: PendingToolCallEvent | null } = {
        current: null,
      };
      let toolCallResolver: (() => void) | null = null;
      const toolCallPromise = new Promise<void>((resolve) => {
        toolCallResolver = resolve;
      });

      const onToolCall = (event: PendingToolCallEvent) => {
        if (event.sessionId === acpSessionId || event.sessionId === "default") {
          interceptedToolCallRef.current = event;
          toolCallResolver?.();
        }
      };

      if (mcpServer) {
        mcpServer.on("tool_call", onToolCall);
      }

      const textChunks: string[] = [];
      const chunkCollector = (chunk: any) => {
        if (chunk.type === "text") {
          textChunks.push(chunk.text);
        }
      };

      let promptPromise: Promise<any>;
      if (activeContinuation?.promptPromise) {
        (connection as any).activeStreams.set(acpSessionId, chunkCollector);
        promptPromise = activeContinuation.promptPromise;
      } else {
        promptPromise = connection.prompt(acpSessionId, promptText, chunkCollector);
      }

      const raceResult = await Promise.race([
        promptPromise.then((res) => ({ type: "prompt" as const, res })),
        toolCallPromise.then(() => ({ type: "tool" as const })),
      ]);

      if (mcpServer) {
        mcpServer.off("tool_call", onToolCall);
      }

      const toolCall = interceptedToolCallRef.current;
      if (raceResult.type === "tool" && toolCall) {
        const continuation = mcpServer?.continuationStore.get(toolCall.callId);
        if (continuation) {
          continuation.promptPromise = promptPromise;
        }

        return c.json({
          id: `chatcmpl-${acpSessionId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: req.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: textChunks.length > 0 ? textChunks.join("") : null,
                tool_calls: [
                  {
                    id: toolCall.callId,
                    type: "function",
                    function: {
                      name: toolCall.toolName,
                      arguments: JSON.stringify(toolCall.arguments),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }

      const promptRes = (raceResult as any).res;
      let content = textChunks.join("");
      const finishReason = mapFinishReason(promptRes.stopReason);

      if (!content && (promptRes.stopReason === "cancelled" || promptRes.stopReason === "refusal")) {
        c.header("x-acp-warnings", "tool_permission_denied");
        content = `[Action cancelled: Agent tool execution was denied under bridge permission policy '${config.permissionPolicy}'].`;
      }

      finalizeSession(content);

      return c.json({
        id: `chatcmpl-${acpSessionId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
            },
            finish_reason: finishReason,
          },
        ],
        usage: promptRes.usage
          ? {
              prompt_tokens: promptRes.usage.inputTokens,
              completion_tokens: promptRes.usage.outputTokens,
              total_tokens: promptRes.usage.totalTokens,
            }
          : {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
      });
    } finally {
      // For non-stream, lock is released immediately here.
      // For stream, lock is released in onEnd handler.
      if (!req.stream) {
        lock.release(key);
      }
    }
  });

  return router;
}

export function createSessionsRouter(
  sessionStore: SessionStore,
  connection: Connection
): Hono {
  const router = new Hono();

  router.get("/sessions", (c) => {
    const principalId = "default";
    const sessions = sessionStore.getAllForPrincipal(principalId);
    return c.json({
      data: sessions.map((s) => ({
        key: s.key,
        conversationId: s.conversationId,
        acpSessionId: s.acpSessionId,
        model: s.model,
        messagesCount: s.messagesCount,
        lastUsedAt: s.lastUsedAt,
        isActive: s.activeTurn !== null,
      })),
    });
  });

  router.delete("/sessions/:key", async (c) => {
    const key = c.req.param("key");
    const conv = sessionStore.get(key);
    if (!conv) {
      return c.json({ error: { message: "Session not found", type: "not_found" } }, 404);
    }
    await connection.closeSession(conv.acpSessionId).catch(() => {});
    sessionStore.delete(key);
    return c.json({ success: true, message: `Session ${key} closed and deleted` });
  });

  return router;
}
