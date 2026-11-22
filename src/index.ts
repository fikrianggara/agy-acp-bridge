import { serve } from "@hono/node-server";
import { execSync } from "node:child_process";
import { loadEnvConfig } from "./config.js";
import { Supervisor } from "./acp/supervisor.js";
import { ModelService } from "./http/models.js";
import { SessionStore } from "./sessions/store.js";
import { KeyedLock } from "./sessions/lock.js";
import { createApp } from "./http/app.js";
import { McpBridgeServer } from "./mcp/server.js";

async function main() {
  const config = loadEnvConfig();

  // 1. Pre-flight check: ensure agy binary exists
  try {
    execSync(`which ${config.agyBin}`, { stdio: "ignore" });
  } catch {
    console.error(
      `[FATAL] Antigravity CLI binary ('${config.agyBin}') not found in PATH. Please install or specify AGY_BIN.`
    );
    process.exit(1);
  }

  // 2. Start MCP Bridge Server for IDE tools
  const mcpServer = new McpBridgeServer();
  const mcpPort = await mcpServer.start(0);
  console.info(`[BOOT] Started MCP bridge TCP server on port ${mcpPort}`);

  // 3. Start ACP Supervisor
  const supervisor = new Supervisor(config, config.agyBin, ["acp"], mcpServer);
  try {
    console.info(`[BOOT] Initializing Antigravity ACP child process (${config.agyBin} acp)...`);
    await supervisor.start();
    console.info("[BOOT] Antigravity ACP initialized successfully.");
  } catch (err: any) {
    if (err.name === "AcpAuthError") {
      console.warn(
        `[WARN] Antigravity CLI requires login: ${err.message}. Run 'agy acp --login' or export GEMINI_API_KEY.`
      );
    } else {
      console.error(`[BOOT] Error initializing ACP: ${err.message}`);
    }
  }

  const modelService = new ModelService(supervisor.connection);
  const sessionStore = new SessionStore(config.sessionTtlMs, config.maxSessions);
  const lock = new KeyedLock();

  const app = createApp({
    config,
    connection: supervisor.connection,
    modelService,
    sessionStore,
    lock,
    isReady: () => supervisor.isReady(),
    mcpServer,
  });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });

  console.info(`[READY] OpenAI-ACP bridge listening on http://${config.host}:${config.port}`);

  const shutdown = async (signal: string) => {
    console.info(`[SHUTDOWN] Received ${signal}, closing server and child process...`);
    server.close();
    await supervisor.shutdown();
    await mcpServer.close();
    console.info("[SHUTDOWN] Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}
