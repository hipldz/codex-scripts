import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { JsonRpcId, JsonRpcMessage } from "./protocol.js";

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<JsonRpcId, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  status: "starting" | "ready" | "error" | "stopped" = "stopped";
  userAgent = "Codex";

  constructor(private cwd: string) { super(); }
  get pid() { return this.child?.pid; }

  async start() {
    this.status = "starting";
    const command = process.platform === "win32"
      ? (process.env.ComSpec || process.env.COMSPEC || "cmd.exe")
      : "codex";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "codex", "app-server", "--stdio"]
      : ["app-server", "--stdio"];
    this.child = spawn(command, args, { cwd: this.cwd, env: process.env });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => { try { this.handle(JSON.parse(line)); } catch { this.emit("warning", `Malformed app-server message: ${line.slice(0, 100)}`); } });
    this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString()));
    this.child.on("error", (error) => {
      this.status = "error";
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit("status", this.status);
    });
    this.child.on("exit", (code) => {
      this.status = code === 0 ? "stopped" : "error";
      for (const pending of this.pending.values()) pending.reject(new Error(`Codex exited (${code})`));
      this.pending.clear(); this.emit("status", this.status);
    });
    try {
      const info = await this.request("initialize", { clientInfo: { name: "codex-web-harness", title: "Codex Web", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
      this.notify("initialized", {});
      this.userAgent = info.userAgent || this.userAgent;
      this.status = "ready"; this.emit("status", this.status);
    } catch (error) { this.status = "error"; this.emit("status", this.status); throw error; }
  }

  private handle(message: JsonRpcMessage) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      return;
    }
    this.emit("message", message);
  }

  private send(message: JsonRpcMessage) {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method: string, params: Record<string, any> = {}) {
    const id = ++this.id;
    return new Promise<any>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ id, method, params }); });
  }
  notify(method: string, params: Record<string, any> = {}) { this.send({ method, params }); }
  respond(id: JsonRpcId, result: any) { this.send({ id, result }); }
  stop() { this.child?.kill("SIGTERM"); }
}
