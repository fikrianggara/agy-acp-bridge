import { Hono } from "hono";
import { Connection } from "../acp/connection.js";
import { Config } from "../config.js";
import { ModelService } from "./models.js";
import {
  ChatCompletionRequestSchema,
  getUnsupportedWarnings,
  formatSystemContext,
  stringifyMessageContent,
} from "../mapping/request.js";
import { mapFinishReason } from "../mapping/finish.js";

export function createChatRouter(
  connection: Connection,
  modelService: ModelService,
  config: Config
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

    // Get models to validate model
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

    // Create a new session or load
    const session = await connection.newSession({ cwd });

    // Validate and set model
    await connection.setConfigOption(session.sessionId, "model", req.model);

    // Validate and set thought level if header present
    const thoughtHeader = c.req.header("x-acp-thought-level");
    if (thoughtHeader) {
      const thoughtOpt = session.configOptions.find(
        (o) => o.category === "thought_level"
      );
      const validValues = thoughtOpt?.options.map((o) => o.value) ?? [];
      if (!validValues.includes(thoughtHeader)) {
        await connection.closeSession(session.sessionId).catch(() => {});
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
        session.sessionId,
        "thought_level",
        thoughtHeader
      );
    }

    // Validate and set mode if header present
    const modeHeader = c.req.header("x-acp-mode");
    if (modeHeader) {
      await connection.setConfigOption(session.sessionId, "mode", modeHeader);
    }

    // Extract system messages for prefix context injection (memory & skills)
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const nonSystemMessages = req.messages.filter((m) => m.role !== "system");

    const systemPrefix = formatSystemContext(systemMessages);

    // Construct prompt text
    let promptText = "";
    if (nonSystemMessages.length === 1) {
      const userMsg = nonSystemMessages[0];
      promptText = systemPrefix + stringifyMessageContent(userMsg.content);
    } else {
      // Multiple messages or replay
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

    // Warnings header
    const warnings = getUnsupportedWarnings(req);
    if (warnings.length > 0) {
      c.header("x-acp-warnings", warnings.join(", "));
    }
    c.header("x-acp-session-id", session.sessionId);

    // If stream = false (non-stream)
    const textChunks: string[] = [];
    const promptRes = await connection.prompt(
      session.sessionId,
      promptText,
      (chunk) => {
        if (chunk.type === "text") {
          textChunks.push(chunk.text);
        }
      }
    );

    // Close session for non-long-lived request in Task 5 (long-lived managed by session store in Task 8)
    await connection.closeSession(session.sessionId).catch(() => {});

    const content = textChunks.join("");
    const finishReason = mapFinishReason(promptRes.stopReason);

    return c.json({
      id: `chatcmpl-${session.sessionId}`,
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
  });

  return router;
}
