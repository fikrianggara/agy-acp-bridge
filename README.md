# OpenAI-to-ACP Bridge (`openai-acp-bridge`)

A lightweight, high-performance bridge that translates standard **OpenAI API** requests into Google Antigravity's **Agent Client Protocol (ACP)** JSON-RPC over stdio.

It allows any OpenAI-compatible harness, tool, or agent (OpenBot, LangChain, LlamaIndex, aider, Cline, custom SDKs) to talk seamlessly to an Antigravity agent running locally.

---

## Key Capabilities

- **Zero-Drop Session Reconciliation:** Distinguishes growing conversation transcripts (*delta turns*, low latency & zero token waste) from edits/branches/regenerations (*replays*).
- **Multi-Tenancy & Fairness:** Distinct session keys per principal (`sha256(principal:conversation)`), concurrency limits per agent, and global turn limiting.
- **Boot Pre-flight & Health Probes:** Checks binary availability, manages the `agy acp` child process, and exposes `/healthz` (liveness) and `/readyz` (readiness).
- **Audit-Logged Permissions:** Intercepts agent tool-call permissions (`session/request_permission`) and enforces `deny` (default), `allow-reads`, or `allow-all` policies with complete audit logging.
- **Prefix Context Injection:** Injects user memories, system rules, and custom skill instructions from `role: "system"` messages into the agent's turn-1 prompt.
- **OpenAI Streaming (SSE):** Full Server-Sent Events output with `role`, `content`, `finish_reason`, `usage`, and optional reasoning thoughts (`agent_thought_chunk`).
- **Tool Bridging via MCP (Task 15):** Exposes caller-defined OpenAI `tools` to the Antigravity agent over an ephemeral TCP MCP bridge (`--ide-mcp-port`). Turns pause on tool invocations and resume seamlessly when tool results are posted.

---

## Quick Start

### 1. Requirements

- Node.js >= 20
- pnpm >= 9
- Google Antigravity CLI (`agy`) installed and logged in (`agy acp --login` or export `GEMINI_API_KEY`)

### 2. Setup

```bash
cd ~/projects/openai-acp-bridge
pnpm install
cp .env.example .env
pnpm dev
```

The bridge boots `agy acp` on stdio and starts listening on `http://127.0.0.1:8787/v1`.

### 3. Usage with OpenAI SDK

#### Node.js / TypeScript:
```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "optional-token-or-dummy",
  defaultHeaders: {
    "x-acp-conversation": "my-chat-session-01",
    "x-acp-thought-level": "high", // low | medium | high
  },
});

const completion = await client.chat.completions.create({
  model: "gemini-3.8-flash",
  messages: [
    { role: "system", content: "You are an expert system analyst." },
    { role: "user", content: "Review this architecture." },
  ],
  stream: true,
});

for await (const chunk of completion) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

#### cURL:
```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-acp-conversation: test-chat" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI chat completion endpoint (streaming & non-streaming) |
| `GET` | `/v1/models` | Available model list from Antigravity handshake (cached 5 min) |
| `GET` | `/v1/sessions` | List active sessions and states |
| `DELETE` | `/v1/sessions/:key` | Explicitly close and evict a session |
| `GET` | `/healthz` | HTTP liveness probe (`200 OK`) |
| `GET` | `/readyz` | Child process readiness & handshake probe (`200 OK` or `503 Service Unavailable`) |

---

## Custom Headers (Additive)

- `x-acp-conversation`: Explicit conversation ID (recommended). Avoids hash heuristic fallback.
- `x-acp-cwd`: Workspace working directory (must match `ALLOW_ROOTS`).
- `x-acp-thought-level`: Target thinking level (`low`, `medium`, `high`).
- `x-acp-mode`: Agent execution mode (`default`, `plan`, `auto`, etc.).

---

## Permission Policies

When the agent attempts to run tools (read files, execute shell, edit files):

- `deny` (Default): All modifying/execution tools are rejected. Zero unverified side-effects on your machine.
- `allow-reads`: Read, search, fetch, and thinking tools are allowed; shell/executes and writes are rejected.
- `allow-all`: All actions approved once. Recommended only with `agy acp --sandbox`.

All permission requests are logged to the audit log: `{ timestamp, sessionId, toolKind, title, policy, outcome }`.

---

## Tool Calling (MCP Bridging)

OpenAI tools defined in the `tools` array are bridged into the Antigravity ACP runtime using an ephemeral Model Context Protocol (MCP) TCP server (`--ide-mcp-port`):

1. **Discovery & Registration:** When a chat request includes `tools`, the bridge registers them with the active ACP session.
2. **Execution Pause:** When the agent invokes a bridged tool, the bridge pauses the ACP turn and yields an OpenAI response with `finish_reason: "tool_calls"` and `tool_calls: [...]`.
3. **Continuation & Resume:** The client executes the function locally and submits the return value in a follow-up request with `role: "tool"` and matching `tool_call_id`. The bridge delivers the result back to the MCP socket, allowing the agent to complete its turn.
4. **Lifecycle & TTL:** Unresolved tool calls expire after a 10-minute TTL.

> **Note on Transcripts:** Per standard OpenAI specification, multi-turn conversations must pass the cumulative message history in chronological order (`[user, assistant (with tool_calls), tool (with tool_call_id)]`).

---

## Running Tests

```bash
# Run all unit tests (100% deterministic, no tokens used)
pnpm test

# Run real E2E test against live agy binary (requires credit / login)
RUN_ACP_E2E=1 pnpm test
```
