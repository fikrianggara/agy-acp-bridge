import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { formatChatCompletionChunk, OpenAIUsage } from "../mapping/stream.js";
import { mapFinishReason } from "../mapping/finish.js";
import { Connection } from "../acp/connection.js";

export async function handleStreamCompletion(
  c: Context,
  options: {
    connection: Connection;
    sessionId: string;
    model: string;
    promptText: string;
    includeUsage: boolean;
    exposeThoughts: boolean;
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
    onEnd,
  } = options;
  const chunkId = `chatcmpl-${sessionId}`;

  return streamSSE(c, async (stream) => {
    // Keepalive ping interval (15s)
    const pingTimer = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15_000);

    try {
      // First chunk: announce role assistant
      await stream.writeSSE({
        data: JSON.stringify(
          formatChatCompletionChunk(chunkId, model, { role: "assistant" }, null)
        ),
      });

      const promptRes = await connection.prompt(
        sessionId,
        promptText,
        async (chunk) => {
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
        }
      );

      clearInterval(pingTimer);

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
      clearInterval(pingTimer);
      if (onEnd) {
        await onEnd();
      }
    }
  });
}
