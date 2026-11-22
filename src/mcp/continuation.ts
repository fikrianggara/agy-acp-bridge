import { Continuation } from "./types.js";

export class ContinuationStore {
  private continuations = new Map<string, Continuation>();

  constructor(private readonly ttlMs = 600_000) {} // 10 minutes TTL

  public create(
    callId: string,
    sessionId: string,
    rpcId: number | string,
    toolName: string,
    args: Record<string, unknown>,
    resolve: (res: any) => void,
    reject: (err: any) => void
  ): Continuation {
    const continuation: Continuation = {
      callId,
      sessionId,
      rpcId,
      toolName,
      arguments: args,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      resolve,
      reject,
    };
    this.continuations.set(callId, continuation);
    return continuation;
  }

  public get(callId: string): Continuation | undefined {
    const c = this.continuations.get(callId);
    if (!c) return undefined;
    if (Date.now() > c.expiresAt) {
      this.continuations.delete(callId);
      c.reject(new Error("Continuation timed out after 10 minutes"));
      return undefined;
    }
    return c;
  }

  public getBySessionId(sessionId: string): Continuation | undefined {
    for (const c of this.continuations.values()) {
      if (c.sessionId === sessionId) {
        if (Date.now() > c.expiresAt) {
          this.continuations.delete(c.callId);
          c.reject(new Error("Continuation timed out after 10 minutes"));
          return undefined;
        }
        return c;
      }
    }
    return undefined;
  }

  public delete(callId: string): boolean {
    return this.continuations.delete(callId);
  }

  public evictExpired(now = Date.now()): Continuation[] {
    const evicted: Continuation[] = [];
    for (const [id, c] of this.continuations.entries()) {
      if (now > c.expiresAt) {
        this.continuations.delete(id);
        c.reject(new Error("Continuation timed out after 10 minutes"));
        evicted.push(c);
      }
    }
    return evicted;
  }
}
