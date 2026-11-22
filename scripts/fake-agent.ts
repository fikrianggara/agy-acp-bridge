import * as readline from "node:readline";

const scenario = process.env.FAKE_SCENARIO || "default";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let activePromptTimer: NodeJS.Timeout | null = null;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: {
    jsonrpc: string;
    id?: number | string;
    method?: string;
    params?: any;
  };

  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Handle Notifications (no id)
  if (msg.id === undefined) {
    if (msg.method === "session/cancel") {
      if (activePromptTimer) {
        clearTimeout(activePromptTimer);
        activePromptTimer = null;
      }
    }
    return;
  }

  // Handle Requests (has id)
  const id = msg.id;
  const method = msg.method;

  if (method === "initialize") {
    if (scenario === "authfail") {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "Authentication required. Run 'agy acp --login' or export GEMINI_API_KEY.",
        },
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: {
          name: "fake-agy",
          version: "1.5.13",
        },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            resume: true,
            close: true,
            load: true,
            list: true,
            additionalDirectories: true,
          },
        },
        models: {
          currentModel: "gemini-3.8-flash",
          availableModels: [
            { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
            { id: "gemini-3.8-pro", name: "Gemini 3.8 Pro" },
          ],
        },
        authMethods: [
          { id: "oauth-personal", name: "OAuth Personal" },
          { id: "gemini-api-key", name: "Gemini API Key" },
        ],
      },
    });
    return;
  }

  if (method === "session/new" || method === "session/load") {
    const sessionId = "fake-session-" + Math.random().toString(36).slice(2, 8);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId,
        configOptions: [
          {
            category: "model",
            currentValue: "gemini-3.8-flash",
            options: [
              { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
              { value: "gemini-3.8-pro", name: "Gemini 3.8 Pro" },
            ],
          },
          {
            category: "thought_level",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            category: "mode",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
            ],
          },
        ],
      },
    });
    // Agly emits available_commands_update right after session/new
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          commands: [{ name: "/test", description: "Test command" }],
        },
      },
    });
    return;
  }

  if (method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      id,
      result: { success: true },
    });
    return;
  }

  if (method === "session/close") {
    send({
      jsonrpc: "2.0",
      id,
      result: { success: true },
    });
    return;
  }

  if (method === "session/prompt") {
    const sessionId = msg.params?.sessionId || "fake-session-default";

    if (scenario === "crash") {
      process.exit(1);
    }

    if (scenario === "permission") {
      // Send a permission request to the client
      const permReqId = 9999;
      send({
        jsonrpc: "2.0",
        id: permReqId,
        method: "session/request_permission",
        params: {
          sessionId,
          turnId: "turn-1",
          toolCall: {
            toolCallId: "tool-call-1",
            kind: "read",
            title: "Read file src/index.ts",
          },
          options: [
            { optionId: "allow-once", kind: "allow_once", label: "Allow Once" },
            { optionId: "reject-once", kind: "reject_once", label: "Reject" },
          ],
        },
      });
      // Will conclude after prompt flow
    }

    const sendChunks = () => {
      // Chunk 1
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello! " },
          },
        },
      });

      // Chunk 2 (thought if enabled or scenario)
      if (process.env.EMIT_THOUGHTS === "1") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Thinking about hello..." },
            },
          },
        });
      }

      // Chunk 3
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "I am fake agy." },
          },
        },
      });

      // Usage update
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 1200,
            size: 1048576,
          },
        },
      });

      // Prompt result
      send({
        jsonrpc: "2.0",
        id,
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: 150,
            outputTokens: 25,
            thoughtTokens: 0,
            totalTokens: 175,
          },
        },
      });
    };

    if (scenario === "slow") {
      activePromptTimer = setTimeout(sendChunks, 500);
    } else {
      sendChunks();
    }
    return;
  }

  // Fallback for unknown methods
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  });
});
