import crypto from "node:crypto";
import { OpenAIMessage } from "../mapping/request.js";
import { Conversation, SessionBusyError } from "./store.js";

export function computeMessagesDigest(messages: OpenAIMessage[]): string {
  const normalized = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function computeSystemHash(messages: OpenAIMessage[]): string {
  const sys = messages.filter((m) => m.role === "system");
  return computeMessagesDigest(sys);
}

export type ReconcileResult =
  | { kind: "new" }
  | { kind: "delta"; deltaMessages: OpenAIMessage[]; promptText: string }
  | { kind: "replay"; reason: string };

export function reconcile(
  conv: Conversation | undefined,
  messages: OpenAIMessage[],
  currentModel: string
): ReconcileResult {
  if (!conv) {
    return { kind: "new" };
  }

  if (conv.activeTurn !== null) {
    throw new SessionBusyError();
  }

  // Model changed
  if (conv.model !== currentModel) {
    return { kind: "replay", reason: "model_changed" };
  }

  // System prompt changed
  const newSystemHash = computeSystemHash(messages);
  if (conv.systemHash !== newSystemHash) {
    return { kind: "replay", reason: "system_changed" };
  }

  // If messages length is less than or equal to previous count -> branched/regenerate -> replay
  if (messages.length <= conv.messagesCount) {
    return { kind: "replay", reason: "messages_truncated_or_branched" };
  }

  // Check prefix digest (messages[0 .. conv.messagesCount])
  const prefix = messages.slice(0, conv.messagesCount);
  const prefixDigest = computeMessagesDigest(prefix);
  if (prefixDigest !== conv.messagesDigest) {
    return { kind: "replay", reason: "history_edited" };
  }

  // Delta: messages after conv.messagesCount
  const delta = messages.slice(conv.messagesCount);

  let startIndex = 0;
  if (delta[0]?.role === "assistant") {
    const text =
      typeof delta[0].content === "string"
        ? delta[0].content
        : JSON.stringify(delta[0].content);
    if (conv.lastAssistantText && text !== conv.lastAssistantText) {
      return { kind: "replay", reason: "assistant_text_edited" };
    }
    startIndex = 1;
  }

  const userMessages = delta.slice(startIndex);
  if (userMessages.length === 0) {
    return { kind: "replay", reason: "no_new_user_messages" };
  }

  const promptText = userMessages
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    )
    .join("\n\n");

  return {
    kind: "delta",
    deltaMessages: delta,
    promptText,
  };
}
