import { describe, it, expect } from "vitest";
import { PermissionEngine, PermissionRequestParams } from "../../src/acp/permissions.js";

describe("Permission Engine", () => {
  const baseParams: PermissionRequestParams = {
    sessionId: "sess-1",
    turnId: "turn-1",
    toolCall: {
      toolCallId: "call-1",
      kind: "read",
      title: "Read src/index.ts",
    },
    options: [
      { optionId: "opt-allow", kind: "allow_once", label: "Allow" },
      { optionId: "opt-reject", kind: "reject_once", label: "Reject" },
    ],
  };

  it("selects reject_once under 'deny' policy", () => {
    const engine = new PermissionEngine("deny");
    const res = engine.decide(baseParams);
    expect(res.outcome).toEqual({
      outcome: "selected",
      optionId: "opt-reject",
    });
  });

  it("cancels under 'deny' policy if no reject option is available", () => {
    const engine = new PermissionEngine("deny");
    const res = engine.decide({
      ...baseParams,
      options: [{ optionId: "opt-allow", kind: "allow_once" }],
    });
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("allows read operations under 'allow-reads' policy", () => {
    const engine = new PermissionEngine("allow-reads");
    const res = engine.decide(baseParams);
    expect(res.outcome).toEqual({
      outcome: "selected",
      optionId: "opt-allow",
    });
  });

  it("rejects execute/write operations under 'allow-reads' policy", () => {
    const engine = new PermissionEngine("allow-reads");
    const res = engine.decide({
      ...baseParams,
      toolCall: {
        toolCallId: "call-2",
        kind: "execute",
        title: "Run rm -rf",
      },
    });
    expect(res.outcome).toEqual({
      outcome: "selected",
      optionId: "opt-reject",
    });
  });

  it("allows execute operations under 'allow-all' policy", () => {
    const engine = new PermissionEngine("allow-all");
    const res = engine.decide({
      ...baseParams,
      toolCall: {
        toolCallId: "call-3",
        kind: "execute",
        title: "Run build",
      },
    });
    expect(res.outcome).toEqual({
      outcome: "selected",
      optionId: "opt-allow",
    });
  });

  it("records audit logs for each decision", () => {
    const engine = new PermissionEngine("deny");
    engine.decide(baseParams);

    const logs = engine.getAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].sessionId).toBe("sess-1");
    expect(logs[0].toolKind).toBe("read");
    expect(logs[0].title).toBe("Read src/index.ts");
    expect(logs[0].outcome).toBe("selected");
  });
});
