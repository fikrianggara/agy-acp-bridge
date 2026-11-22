import { describe, it, expect, afterAll } from "vitest";
import { Supervisor } from "../../src/acp/supervisor.js";
import { parseConfig } from "../../src/config.js";
import { ModelService } from "../../src/http/models.js";
import { createApp } from "../../src/http/app.js";

const isE2E = process.env.RUN_ACP_E2E === "1";

describe("E2E Real Antigravity CLI", () => {
  let supervisor: Supervisor;

  afterAll(async () => {
    if (supervisor) {
      await supervisor.shutdown();
    }
  });

  (isE2E ? it : it.skip)(
    "completes a real turn against agy acp binary",
    async () => {
      const config = parseConfig({
        agyBin: "agy",
      });
      supervisor = new Supervisor(config);
      await supervisor.start();

      const modelService = new ModelService(supervisor.connection);
      const app = createApp({
        config,
        connection: supervisor.connection,
        modelService,
      });

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          stream: false,
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.choices[0].message.content).toContain("OK");
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    },
    60_000
  );
});
