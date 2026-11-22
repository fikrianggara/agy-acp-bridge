import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Transport } from "../../src/acp/transport.js";
import { Connection } from "../../src/acp/connection.js";
import { parseConfig } from "../../src/config.js";
import { ModelService } from "../../src/http/models.js";
import { createApp } from "../../src/http/app.js";
import { SessionStore } from "../../src/sessions/store.js";
import { KeyedLock } from "../../src/sessions/lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = path.resolve(__dirname, "../../scripts/fake-agent.ts");

describe("Chat Sessions and Concurrency Locking", () => {
  let child: ChildProcessWithoutNullStreams;
  let transport: Transport;
  let connection: Connection;
  let modelService: ModelService;

  beforeEach(async () => {
    child = spawn("pnpm", ["tsx", fakeAgentPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    transport = new Transport(child, (notif) => {
      connection.handleNotification(notif.method, notif.params);
    });
    connection = new Connection(transport, 5000);
    await connection.initialize();
    modelService = new ModelService(connection);
  });

  afterEach(() => {
    transport?.close();
    child?.kill("SIGTERM");
  });

  it("handles multi-turn conversation with delta prompt on the same session", async () => {
    const config = parseConfig({});
    const sessionStore = new SessionStore();
    const lock = new KeyedLock();
    const app = createApp({ config, connection, modelService, sessionStore, lock });

    // Turn 1
    const res1 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acp-conversation": "test-chat-multi",
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Hi, I am Fikri" }],
      }),
    });

    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as any;
    const sessionId1 = res1.headers.get("x-acp-session-id");
    expect(sessionId1).toBeDefined();

    // Turn 2 (Delta)
    const res2 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acp-conversation": "test-chat-multi",
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [
          { role: "user", content: "Hi, I am Fikri" },
          { role: "assistant", content: body1.choices[0].message.content },
          { role: "user", content: "What is my name?" },
        ],
      }),
    });

    expect(res2.status).toBe(200);
    const sessionId2 = res2.headers.get("x-acp-session-id");
    // Verify session ID is reused (long-lived session)
    expect(sessionId2).toBe(sessionId1);
  });

  it("returns 409 session_busy when two requests hit the same session simultaneously", async () => {
    const config = parseConfig({});
    const sessionStore = new SessionStore();
    const lock = new KeyedLock();
    const app = createApp({ config, connection, modelService, sessionStore, lock });

    // Send two requests in parallel to the exact same conversation
    const [p1, p2] = await Promise.all([
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acp-conversation": "concurrent-chat-1",
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Message 1" }],
        }),
      }),
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acp-conversation": "concurrent-chat-1",
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Message 2" }],
        }),
      }),
    ]);

    const statuses = [p1.status, p2.status].sort();
    // One must succeed (200), and the other must be rejected as busy (409)
    expect(statuses).toEqual([200, 409]);
  });

  it("allows parallel requests across different conversations", async () => {
    const config = parseConfig({});
    const sessionStore = new SessionStore();
    const lock = new KeyedLock();
    const app = createApp({ config, connection, modelService, sessionStore, lock });

    const [p1, p2] = await Promise.all([
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acp-conversation": "parallel-chat-A",
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Chat A" }],
        }),
      }),
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acp-conversation": "parallel-chat-B",
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          messages: [{ role: "user", content: "Chat B" }],
        }),
      }),
    ]);

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
  });

  it("lists and deletes sessions via /v1/sessions", async () => {
    const config = parseConfig({});
    const sessionStore = new SessionStore();
    const lock = new KeyedLock();
    const app = createApp({ config, connection, modelService, sessionStore, lock });

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acp-conversation": "chat-to-delete",
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "Init chat" }],
      }),
    });

    // List
    const listRes = await app.request("/v1/sessions");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.data.length).toBe(1);
    const key = listBody.data[0].key;

    // Delete
    const delRes = await app.request(`/v1/sessions/${key}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    // List again should be empty
    const listRes2 = await app.request("/v1/sessions");
    const listBody2 = (await listRes2.json()) as any;
    expect(listBody2.data.length).toBe(0);
  });
});
