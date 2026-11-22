import crypto from "node:crypto";
import { OpenAIMessage } from "../mapping/request.js";

export class SessionBusyError extends Error {
  constructor(message = "Session is currently busy processing another turn") {
    super(message);
    this.name = "SessionBusyError";
  }
}

export type TurnState = {
  turnId: string;
  startedAt: number;
};

export type Conversation = {
  key: string;
  principalId: string;
  conversationId: string;
  acpSessionId: string;
  cwd: string;
  model: string;
  systemHash: string;
  messagesDigest: string;
  messagesCount: number;
  lastAssistantText: string;
  createdAt: number;
  lastUsedAt: number;
  activeTurn: TurnState | null;
};

export class SessionStore {
  private conversations = new Map<string, Conversation>();

  constructor(
    private readonly ttlMs = 1_800_000,
    private readonly maxSessions = 50
  ) {}

  public get(key: string): Conversation | undefined {
    return this.conversations.get(key);
  }

  public set(conv: Conversation): void {
    // If over limit, evict LRU
    if (this.conversations.size >= this.maxSessions && !this.conversations.has(conv.key)) {
      this.evictLru();
    }
    this.conversations.set(conv.key, conv);
  }

  public delete(key: string): boolean {
    return this.conversations.delete(key);
  }

  public getAllForPrincipal(principalId: string): Conversation[] {
    return [...this.conversations.values()].filter(
      (c) => c.principalId === principalId
    );
  }

  public evictStale(now = Date.now()): Conversation[] {
    const evicted: Conversation[] = [];
    for (const [key, conv] of this.conversations.entries()) {
      if (!conv.activeTurn && now - conv.lastUsedAt > this.ttlMs) {
        this.conversations.delete(key);
        evicted.push(conv);
      }
    }
    return evicted;
  }

  private evictLru(): Conversation | undefined {
    let oldest: Conversation | undefined;
    for (const conv of this.conversations.values()) {
      if (conv.activeTurn) continue; // Don't evict active turns
      if (!oldest || conv.lastUsedAt < oldest.lastUsedAt) {
        oldest = conv;
      }
    }
    if (oldest) {
      this.conversations.delete(oldest.key);
    }
    return oldest;
  }
}

export function computeKey(principalId: string, conversationId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${principalId}:${conversationId}`)
    .digest("hex");
}
