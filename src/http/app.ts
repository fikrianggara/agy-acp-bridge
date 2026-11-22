import { Hono } from "hono";
import { Config } from "../config.js";
import { Connection } from "../acp/connection.js";
import { ModelService, createModelsRouter } from "./models.js";
import { createChatRouter } from "./chat.js";

export interface AppContext {
  config: Config;
  connection: Connection;
  modelService: ModelService;
  isReady?: () => boolean;
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  // Liveness probe (no auth)
  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  // Readiness probe (no auth)
  app.get("/readyz", (c) => {
    const ready = ctx.isReady ? ctx.isReady() : true;
    if (ready) {
      return c.json({ status: "ready" });
    }
    return c.json({ status: "unready", message: "ACP agent is not ready" }, 503);
  });

  // Bearer auth middleware for /v1/*
  app.use("/v1/*", async (c, next) => {
    if (!ctx.config.authToken) {
      return next();
    }
    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          error: {
            message: "Missing or invalid Authorization header",
            type: "invalid_request_error",
          },
        },
        401
      );
    }
    const token = authHeader.slice(7).trim();
    if (token !== ctx.config.authToken) {
      return c.json(
        {
          error: {
            message: "Incorrect API key provided",
            type: "invalid_request_error",
          },
        },
        401
      );
    }
    return next();
  });

  // Mount models and chat routes under /v1
  const modelsRouter = createModelsRouter(ctx.modelService);
  app.route("/v1", modelsRouter);

  const chatRouter = createChatRouter(ctx.connection, ctx.modelService, ctx.config);
  app.route("/v1", chatRouter);

  return app;
}
