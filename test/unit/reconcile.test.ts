import { describe, it, expect } from "vitest";
import {
  reconcile,
  computeMessagesDigest,
  computeSystemHash,
} from "../../src/sessions/reconcile.js";
import { Conversation, SessionBusyError } from "../../src/sessions/store.js";
import { OpenAIMessage } from "../../src/mapping/request.js";

describe("Session Reconciliation", () => {
  const initialMessages: OpenAIMessage[] = [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hello" },
  ];

  const baseConv: Conversation = {
    key: "conv-1",
    principalId: "default",
    conversationId: "c1",
    acpSessionId: "session-1",
    cwd: "/projects",
    model: "gemini-3.8-flash",
    systemHash: computeSystemHash(initialMessages),
    messagesDigest: computeMessagesDigest(initialMessages),
    messagesCount: 2,
    lastAssistantText: "Hi! How can I help?",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    activeTurn: null,
  };

  it("returns 'new' when conversation is not known", () => {
    const res = reconcile(undefined, initialMessages, "gemini-3.8-flash");
    expect(res.kind).toBe("new");
  });

  it("returns 'delta' when transcript appends matching assistant and new user message", () => {
    const messages: OpenAIMessage[] = [
      ...initialMessages,
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2 + 2?" },
    ];

    const res = reconcile(baseConv, messages, "gemini-3.8-flash");
    expect(res.kind).toBe("delta");
    if (res.kind === "delta") {
      expect(res.promptText).toBe("What is 2 + 2?");
    }
  });

  it("returns 'replay' when assistant message was edited (regenerate)", () => {
    const messages: OpenAIMessage[] = [
      ...initialMessages,
      { role: "assistant", content: "DIFFERENT ASSISTANT TEXT" },
      { role: "user", content: "What is 2 + 2?" },
    ];

    const res = reconcile(baseConv, messages, "gemini-3.8-flash");
    expect(res.kind).toBe("replay");
    if (res.kind === "replay") {
      expect(res.reason).toBe("assistant_text_edited");
    }
  });

  it("returns 'replay' when an earlier user message was edited", () => {
    const editedMessages: OpenAIMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "EDITED Hello" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2 + 2?" },
    ];

    const res = reconcile(baseConv, editedMessages, "gemini-3.8-flash");
    expect(res.kind).toBe("replay");
    if (res.kind === "replay") {
      expect(res.reason).toBe("history_edited");
    }
  });

  it("returns 'replay' when system prompt changes", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are a pirate assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2 + 2?" },
    ];

    const res = reconcile(baseConv, messages, "gemini-3.8-flash");
    expect(res.kind).toBe("replay");
    if (res.kind === "replay") {
      expect(res.reason).toBe("system_changed");
    }
  });

  it("returns 'replay' when model changes", () => {
    const messages: OpenAIMessage[] = [
      ...initialMessages,
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2 + 2?" },
    ];

    const res = reconcile(baseConv, messages, "gemini-3.8-pro");
    expect(res.kind).toBe("replay");
    if (res.kind === "replay") {
      expect(res.reason).toBe("model_changed");
    }
  });

  it("throws SessionBusyError when an active turn is in progress", () => {
    const busyConv: Conversation = {
      ...baseConv,
      activeTurn: {
        turnId: "turn-abc",
        startedAt: Date.now(),
      },
    };

    expect(() =>
      reconcile(busyConv, initialMessages, "gemini-3.8-flash")
    ).toThrow(SessionBusyError);
  });
});
