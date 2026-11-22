import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/config.js";

describe("Config", () => {
  it("produces correct defaults when given empty input", () => {
    const config = parseConfig({});
    expect(config.port).toBe(8787);
    expect(config.host).toBe("127.0.0.1");
    expect(config.sessionTtlMs).toBe(1_800_000);
    expect(config.maxSessions).toBe(50);
    expect(config.permissionPolicy).toBe("deny");
    expect(config.toolsMode).toBe("ignore");
    expect(config.maxActiveTurns).toBe(4);
    expect(config.agyBin).toBe("agy");
  });

  it("coerces and overrides valid fields", () => {
    const config = parseConfig({
      port: "9000",
      host: "0.0.0.0",
      permissionPolicy: "allow-reads",
      toolsMode: "reject",
      maxActiveTurns: "8",
    });
    expect(config.port).toBe(9000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.permissionPolicy).toBe("allow-reads");
    expect(config.toolsMode).toBe("reject");
    expect(config.maxActiveTurns).toBe(8);
  });

  it("throws on invalid enum values", () => {
    expect(() =>
      parseConfig({
        permissionPolicy: "invalid-policy",
      })
    ).toThrow();
  });
});
