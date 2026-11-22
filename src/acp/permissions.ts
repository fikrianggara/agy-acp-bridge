export type PermissionOption = {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
  label?: string;
};

export type PermissionRequestParams = {
  sessionId: string;
  turnId?: string;
  toolCall?: {
    toolCallId?: string;
    kind?: string;
    title?: string;
  };
  options: PermissionOption[];
};

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface PermissionAuditEntry {
  timestamp: number;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  toolKind?: string;
  title?: string;
  policy: string;
  outcome: string;
  optionId?: string;
}

export class PermissionEngine {
  private auditLogs: PermissionAuditEntry[] = [];

  constructor(
    private readonly defaultPolicy: "deny" | "allow-reads" | "allow-all" = "deny"
  ) {}

  public decide(
    params: PermissionRequestParams,
    overridePolicy?: "deny" | "allow-reads" | "allow-all"
  ): { outcome: PermissionOutcome } {
    const policy = overridePolicy || this.defaultPolicy;
    const { sessionId, turnId, toolCall, options } = params;
    const kind = toolCall?.kind || "unknown";

    let chosenOptionId: string | undefined;
    let outcome: "selected" | "cancelled" = "cancelled";

    const allowOnce = options.find((o) => o.kind === "allow_once");
    const rejectOnce = options.find(
      (o) => o.kind === "reject_once" || o.kind === "reject_always"
    );

    if (policy === "deny") {
      if (rejectOnce) {
        outcome = "selected";
        chosenOptionId = rejectOnce.optionId;
      } else {
        outcome = "cancelled";
      }
    } else if (policy === "allow-all") {
      if (allowOnce) {
        outcome = "selected";
        chosenOptionId = allowOnce.optionId;
      } else {
        outcome = "cancelled";
      }
    } else if (policy === "allow-reads") {
      const readKinds = ["read", "search", "fetch", "think"];
      if (readKinds.includes(kind)) {
        if (allowOnce) {
          outcome = "selected";
          chosenOptionId = allowOnce.optionId;
        } else {
          outcome = "cancelled";
        }
      } else {
        if (rejectOnce) {
          outcome = "selected";
          chosenOptionId = rejectOnce.optionId;
        } else {
          outcome = "cancelled";
        }
      }
    }

    const auditEntry: PermissionAuditEntry = {
      timestamp: Date.now(),
      sessionId,
      turnId,
      toolCallId: toolCall?.toolCallId,
      toolKind: toolCall?.kind,
      title: toolCall?.title,
      policy,
      outcome,
      optionId: chosenOptionId,
    };
    this.auditLogs.push(auditEntry);

    return {
      outcome:
        outcome === "selected" && chosenOptionId
          ? { outcome: "selected", optionId: chosenOptionId }
          : { outcome: "cancelled" },
    };
  }

  public getAuditLogs(): PermissionAuditEntry[] {
    return this.auditLogs;
  }
}
