import { z } from "zod";

export class AcpAuthError extends Error {
  constructor(message = "ACP authentication required") {
    super(message);
    this.name = "AcpAuthError";
  }
}

export class AcpTimeoutError extends Error {
  constructor(message = "ACP request timed out") {
    super(message);
    this.name = "AcpTimeoutError";
  }
}

export const ConfigOptionSchema = z.object({
  category: z.string(),
  currentValue: z.string().optional(),
  options: z.array(
    z.object({
      value: z.string(),
      name: z.string().optional(),
    })
  ),
});

export type ConfigOption = z.infer<typeof ConfigOptionSchema>;

export const InitializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  agentCapabilities: z.record(z.unknown()).optional(),
  models: z
    .object({
      currentModel: z.string().optional(),
      availableModels: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
  authMethods: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
      })
    )
    .optional(),
});

export type InitializeResult = z.infer<typeof InitializeResultSchema>;

export const SessionNewResultSchema = z.object({
  sessionId: z.string(),
  configOptions: z.array(ConfigOptionSchema).optional().default([]),
});

export type SessionNewResult = z.infer<typeof SessionNewResultSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  thoughtTokens: z.number().default(0),
  totalTokens: z.number().default(0),
  cachedReadTokens: z.number().optional(),
  cachedWriteTokens: z.number().optional(),
});

export type AcpUsage = z.infer<typeof UsageSchema>;

export const SessionPromptResultSchema = z.object({
  stopReason: z.string().default("end_turn"),
  usage: UsageSchema.optional(),
});

export type SessionPromptResult = z.infer<typeof SessionPromptResultSchema>;

export type PromptChunkCallback = (chunk: {
  type: "text" | "thought";
  text: string;
}) => void;
