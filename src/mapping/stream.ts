export type OpenAIChunkDelta = {
  role?: string;
  content?: string;
  reasoning_content?: string;
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export function formatChatCompletionChunk(
  id: string,
  model: string,
  delta: OpenAIChunkDelta,
  finishReason: string | null = null,
  usage?: OpenAIUsage
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
