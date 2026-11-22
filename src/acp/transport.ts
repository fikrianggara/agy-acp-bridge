import type { ChildProcessWithoutNullStreams } from "node:child_process";

export class AcpTransportClosed extends Error {
  constructor(message = "ACP transport closed") {
    super(message);
    this.name = "AcpTransportClosed";
  }
}

export class AcpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export class Transport {
  private seq = 0;
  private pending = new Map<
    number | string,
    { resolve: (val: unknown) => void; reject: (err: Error) => void }
  >();
  private lineBuffer = "";
  private isClosed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotify?: (m: JsonRpcNotification) => void,
    private readonly onRequest?: (m: JsonRpcRequest) => Promise<unknown>
  ) {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleData(chunk));
    this.child.on("close", (code, signal) => this.handleClose(code, signal));
    this.child.on("error", (err) => this.handleError(err));
  }

  public request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(new AcpTransportClosed());
    }

    const id = ++this.seq;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });

      this.sendLine(JSON.stringify(payload));
    });
  }

  public notify(method: string, params?: unknown): void {
    if (this.isClosed) return;
    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.sendLine(JSON.stringify(payload));
  }

  public respond(
    id: number | string,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown }
  ): void {
    if (this.isClosed) return;
    const payload: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result: result ?? {} }),
    };
    this.sendLine(JSON.stringify(payload));
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cleanupPending(new AcpTransportClosed("Transport closed explicitly"));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
  }

  private sendLine(line: string): void {
    try {
      this.child.stdin.write(line + "\n");
    } catch (err) {
      this.cleanupPending(
        new AcpTransportClosed(`Failed to write to stdin: ${String(err)}`)
      );
    }
  }

  private handleData(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    // The last part is incomplete unless the chunk ended with \n
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.parseLine(trimmed);
    }
  }

  private parseLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      // In NDJSON, skip unparseable lines (don't crash)
      return;
    }

    if (msg.jsonrpc !== "2.0") return;

    // Response (has id and result or error)
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      const pendingItem = this.pending.get(msg.id as number | string);
      if (pendingItem) {
        this.pending.delete(msg.id as number | string);
        if (msg.error) {
          const err = msg.error as { code: number; message: string; data?: unknown };
          pendingItem.reject(
            new AcpRpcError(err.code, err.message, err.data)
          );
        } else {
          pendingItem.resolve(msg.result);
        }
      }
      return;
    }

    // Incoming Request from server (has id and method)
    if (msg.id !== undefined && typeof msg.method === "string") {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: msg.id as number | string,
        method: msg.method,
        params: msg.params,
      };
      if (this.onRequest) {
        this.onRequest(req)
          .then((res) => this.respond(req.id, res))
          .catch((err) =>
            this.respond(req.id, undefined, {
              code: -32603,
              message: String(err?.message ?? err),
            })
          );
      } else {
        // Default reject if no handler
        this.respond(req.id, undefined, {
          code: -32601,
          message: `Method not found: ${req.method}`,
        });
      }
      return;
    }

    // Notification (has method, no id)
    if (typeof msg.method === "string" && msg.id === undefined) {
      const notif: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: msg.method,
        params: msg.params,
      };
      this.onNotify?.(notif);
      return;
    }
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.isClosed = true;
    this.cleanupPending(
      new AcpTransportClosed(
        `Child process exited with code ${code ?? "null"}, signal ${signal ?? "null"}`
      )
    );
  }

  private handleError(err: Error): void {
    this.isClosed = true;
    this.cleanupPending(
      new AcpTransportClosed(`Child process error: ${err.message}`)
    );
  }

  private cleanupPending(err: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }
}
