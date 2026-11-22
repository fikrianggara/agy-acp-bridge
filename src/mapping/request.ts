import { z } from "zod";

export const OpenAIMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.unknown()), z.record(z.unknown())]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
});

export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;

export const OpenAIToolSchema = z.object({
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

export type OpenAITool = z.infer<typeof OpenAIToolSchema>;

export const ChatCompletionRequestSchema = z.object({
  messages: z.array(OpenAIMessageSchema).min(1),
  model: z.string(),
  stream: z.boolean().optional().default(false),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  user: z.string().optional(),
  tools: z.array(OpenAIToolSchema).optional(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().optional(),
  max_tokens: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export function getUnsupportedWarnings(
  req: ChatCompletionRequest,
  options?: { mcpBridgeEnabled?: boolean }
): string[] {
  const warnings: string[] = [];
  if (req.temperature !== undefined) warnings.push("temperature");
  if (req.top_p !== undefined) warnings.push("top_p");
  if (req.max_tokens !== undefined) warnings.push("max_tokens");
  if (req.stop !== undefined) warnings.push("stop");
  if (!options?.mcpBridgeEnabled && req.tools && req.tools.length > 0) {
    warnings.push("tools_ignored");
  }
  return warnings;
}

export function formatSystemContext(systemMessages: OpenAIMessage[]): string {
  if (systemMessages.length === 0) return "";
  const parts = systemMessages.map((m) => {
    return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  });

  return [
    "[System Instructions & Context]",
    ...parts,
    "[End Context]",
    "",
  ].join("\n");
}

export function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return JSON.stringify(content);
}
