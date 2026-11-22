import { z } from "zod";

export const ConfigSchema = z.object({
  port: z.coerce.number().default(8787),
  host: z.string().default("127.0.0.1"),
  sessionTtlMs: z.coerce.number().default(1_800_000),
  maxSessions: z.coerce.number().default(50),
  permissionPolicy: z.enum(["deny", "allow-reads", "allow-all"]).default("deny"),
  toolsMode: z.enum(["ignore", "reject"]).default("ignore"),
  maxActiveTurns: z.coerce.number().default(4),
  agyBin: z.string().default("agy"),
  allowRoots: z
    .array(z.string())
    .default(
      process.env.HOME ? [`${process.env.HOME}/projects`] : ["/projects"]
    ),
  authToken: z.string().optional(),
  exposeThoughts: z.coerce.boolean().default(false),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(raw: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse(raw);
}

export function loadEnvConfig(): Config {
  const allowRootsRaw = process.env.ALLOW_ROOTS;
  const allowRoots = allowRootsRaw
    ? allowRootsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  return parseConfig({
    port: process.env.PORT,
    host: process.env.HOST,
    sessionTtlMs: process.env.SESSION_TTL_MS,
    maxSessions: process.env.MAX_SESSIONS,
    permissionPolicy: process.env.PERMISSION_POLICY,
    toolsMode: process.env.TOOLS_MODE,
    maxActiveTurns: process.env.MAX_ACTIVE_TURNS,
    agyBin: process.env.AGY_BIN,
    allowRoots,
    authToken: process.env.AUTH_TOKEN,
    exposeThoughts: process.env.EXPOSE_THOUGHTS === "1",
    logLevel: process.env.LOG_LEVEL,
  });
}
