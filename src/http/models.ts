import { Hono } from "hono";
import { Connection } from "../acp/connection.js";

export type ModelItem = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

export class ModelService {
  private cache: { timestamp: number; data: ModelItem[] } | null = null;
  private readonly ttlMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly connection: Connection,
    private readonly probeCwd: string = process.cwd()
  ) {}

  public async getModels(): Promise<ModelItem[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.timestamp < this.ttlMs) {
      return this.cache.data;
    }

    const session = await this.connection.newSession({ cwd: this.probeCwd });
    const modelOpt = session.configOptions.find((o) => o.category === "model");

    let modelList: string[] = [];
    if (modelOpt && modelOpt.options.length > 0) {
      modelList = modelOpt.options.map((o) => o.value);
    }

    // Close the probe session immediately so it does not leak
    await this.connection.closeSession(session.sessionId).catch(() => {});

    // Fallback if none found
    if (modelList.length === 0) {
      modelList = ["gemini-3.8-flash", "gemini-3.8-pro"];
    }

    const data: ModelItem[] = modelList.map((id) => ({
      id,
      object: "model",
      created: Math.floor(now / 1000),
      owned_by: "antigravity",
    }));

    this.cache = { timestamp: now, data };
    return data;
  }
}

export function createModelsRouter(modelService: ModelService): Hono {
  const router = new Hono();

  router.get("/models", async (c) => {
    try {
      const data = await modelService.getModels();
      return c.json({
        object: "list",
        data,
      });
    } catch (err: any) {
      return c.json(
        {
          error: {
            message: `Failed to fetch models: ${err?.message ?? err}`,
            type: "acp_models_error",
          },
        },
        502
      );
    }
  });

  return router;
}
