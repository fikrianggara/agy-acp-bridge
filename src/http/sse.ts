import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { formatChatCompletionChunk, OpenAIUsage } from "../mapping/stream.js";
import { mapFinishReason } from "../mapping/finish.js";
import { Connection } from "../acp/connection.js";
import { McpBridgeServer, PendingToolCallEvent } from "../mcp/server.js";
import { Continuation } from "../mcp/types.js";

export async function handleStreamCompletion(
  c: Context,
  options: {
    connection: Connection;
    sessionId: string;
    model: string;
    promptText: string;
    includeUsage: boolean;
    exposeThoughts: boolean;
    mcpServer?: McpBridgeServer;
    continuation?: Continuation;
    onEnd?: () => Promise<void> | void;
  }
) {
  const {
    connection,
    sessionId,
    model,
    promptText,
    includeUsage,
    exposeThoughts,
    mcpServer,
    continuation,
    onEnd,
  } = options;
  const chunkId = `chatcmpl-${sessionId}`;

  return streamSSE(c, async (stream) => {
    // Keepalive ping interval (15s)
    const pingTimer = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15_000);

    let onToolCall: ((event: PendingToolCallEvent) => void) | null = null;

    try {
      // First chunk: announce role assistant
      await stream.writeSSE({
        data: JSON.stringify(
          formatChatCompletionChunk(chunkId, model, { role: "assistant" }, null)
        ),
      });

      const interceptedToolCallRef: { current: PendingToolCallEvent | null } = {
        current: null,
      };
      let toolCallResolver: (() => void) | null = null;
      const toolCallPromise = new Promise<void>((resolve) => {
        toolCallResolver = resolve;
      });

      if (mcpServer) {
        onToolCall = (event: PendingToolCallEvent) => {
          if (event.sessionId === sessionId || event.sessionId === "default") {
            interceptedToolCallRef.current = event;
            toolCallResolver?.();
          }
        };
        mcpServer.on("tool_call", onToolCall);
      }

      const chunkHandler = async (chunk: any) => {
        if (chunk.type === "text") {
          await stream.writeSSE({
            data: JSON.stringify(
              formatChatCompletionChunk(
                chunkId,
                model,
                { content: chunk.text },
                null
              )
            ),
          });
        } else if (chunk.type === "thought" && exposeThoughts) {
          await stream.writeSSE({
            data: JSON.stringify(
              formatChatCompletionChunk(
                chunkId,
                model,
                { reasoning_content: chunk.text },
                null
              )
            ),
          });
        }
      };

      let promptPromise: Promise<any>;
      if (continuation?.promptPromise) {
        promptPromise = continuation.promptPromise;
      } else {
        promptPromise = connection.prompt(sessionId, promptText, chunkHandler);
      }

      const raceResult = await Promise.race([
        promptPromise.then((res) => ({ type: "prompt" as const, res })),
        toolCallPromise.then(() => ({ type: "tool" as const })),
      ]);

      if (onToolCall && mcpServer) {
        mcpServer.off("tool_call", onToolCall);
      }

      clearInterval(pingTimer);

      const toolCall = interceptedToolCallRef.current;
      if (raceResult.type === "tool" && toolCall) {
        const storedContinuation = mcpServer?.continuationStore.get(
          toolCall.callId
        );
        if (storedContinuation) {
          storedContinuation.promptPromise = promptPromise;
        }

        // Emit tool call delta chunk
        await stream.writeSSE({
          data: JSON.stringify(
            formatChatCompletionChunk(
              chunkId,
              model,
              {
                tool_calls: [
                  {
                    index: 0,
                    id: toolCall.callId,
                    type: "function",
                    function: {
                      name: toolCall.toolName,
                      arguments: JSON.stringify(toolCall.arguments),
                    },
                  },
                ],
              },
              null
            )
          ),
        });

        // Emit finish chunk with tool_calls
        await stream.writeSSE({
          data: JSON.stringify(
            formatChatCompletionChunk(chunkId, model, {}, "tool_calls")
          ),
        });

        await stream.write("data: [DONE]\n\n");
        return;
      }

      const promptRes = (raceResult as any).res;
      const finishReason = mapFinishReason(promptRes.stopReason);
      let usage: OpenAIUsage | undefined;
      if (includeUsage && promptRes.usage) {
        usage = {
          prompt_tokens: promptRes.usage.inputTokens,
          completion_tokens: promptRes.usage.outputTokens,
          total_tokens: promptRes.usage.totalTokens,
        };
      }

      // Final chunk with finish reason and optional usage
      await stream.writeSSE({
        data: JSON.stringify(
          formatChatCompletionChunk(chunkId, model, {}, finishReason, usage)
        ),
      });

      // Final OpenAI sentinel
      await stream.write("data: [DONE]\n\n");
    } finally {
      if (onToolCall && mcpServer) {
        mcpServer.off("tool_call", onToolCall);
      }
      clearInterval(pingTimer);
      if (onEnd) {
        await onEnd();
      }
    }
  });
}
