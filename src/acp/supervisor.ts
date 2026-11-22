import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { Transport } from "./transport.js";
import { Connection } from "./connection.js";
import { PermissionEngine } from "./permissions.js";
import { Config } from "../config.js";

export class Supervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private transport: Transport | null = null;
  private _connection: Connection | null = null;
  private ready = false;
  private isShuttingDown = false;
  public readonly permissionEngine: PermissionEngine;

  constructor(
    private readonly config: Config,
    private readonly command: string = config.agyBin,
    private readonly args: string[] = ["acp"]
  ) {
    this.permissionEngine = new PermissionEngine(config.permissionPolicy);
  }

  public get connection(): Connection {
    if (!this._connection) {
      throw new Error("Supervisor is not started or connection not ready");
    }
    return this._connection;
  }

  public isReady(): boolean {
    return this.ready && !this.isShuttingDown;
  }

  public async start(): Promise<void> {
    this.isShuttingDown = false;
    this.spawnChild();
    await this.initializeHandshake();
  }

  private spawnChild(): void {
    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.transport = new Transport(
      this.child,
      (notif) => {
        this._connection?.handleNotification(notif.method, notif.params);
      },
      async (req) => {
        if (req.method === "session/request_permission") {
          return this.permissionEngine.decide(req.params as any);
        }
        throw new Error(`Unsupported agent request method: ${req.method}`);
      }
    );

    this._connection = new Connection(this.transport);

    this.child.on("exit", () => {
      this.ready = false;
      if (!this.isShuttingDown) {
        // Auto-respawn if not intentional shutdown
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.start().catch(() => {});
          }
        }, 500);
      }
    });
  }

  private async initializeHandshake(): Promise<void> {
    if (!this._connection) return;
    try {
      await this._connection.initialize();
      this.ready = true;
    } catch (err) {
      this.ready = false;
      throw err;
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.ready = false;
    this.transport?.close();
    if (this.child) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.child?.kill("SIGKILL");
          resolve();
        }, 3000);
        this.child?.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }
}
