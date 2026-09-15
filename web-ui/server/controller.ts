import crypto from "node:crypto";
import nodeFs from "node:fs/promises";
import v8 from "node:v8";
import { adapt, approval } from "./codex/event-adapter.js";
import type { CodexClient } from "./codex/client.js";
import { AttachmentStore, type AttachmentSummary, type IncomingAttachment } from "./attachments.js";
import type { WorkspaceFs } from "./filesystem.js";
import type { EventHub } from "./event-hub.js";

const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
const threadPermissionSettings = (permission: unknown) => permission === "full" ? { approvalPolicy: "never", sandbox: "danger-full-access" } : permission === "read-only" ? { approvalPolicy: "on-request", sandbox: "read-only" } : { approvalPolicy: "on-request", sandbox: "workspace-write" };
const turnPermissionSettings = (permission: unknown, cwd: string) => permission === "full" ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } : permission === "read-only" ? { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } } : { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const HISTORY_PAGE_SIZE = 60;
const MAX_HISTORY_ITEMS = 500;
const threadSummary = (thread: any) => {
  if (!thread || typeof thread !== "object") return thread;
  const { turns: _turns, ...summary } = thread;
  return summary;
};

const legacyAttachment = (value: unknown): IncomingAttachment | null => {
  if (typeof value !== "string" || !value.startsWith("Attached file \"")) return null;
  const marker = "\":\n\n"; const end = value.indexOf(marker, 15); if (end < 0) return null;
  const name = value.slice(15, end); return !name || name.length > 200 ? null : { name, mime: "text/plain", kind: "text", data: value.slice(end + marker.length) };
};
const legacyMessage = (content: any[]) => { const text: string[] = []; const attachments: IncomingAttachment[] = []; for (const item of content) { if (item.type !== "text") continue; const attachment = legacyAttachment(item.text); attachment ? attachments.push(attachment) : text.push(String(item.text || "")); } return { text: text.join("\n"), attachments }; };
const userMessage = (content: any[], stored?: { prompt: string; attachments: AttachmentSummary[] } | null) => ({
  text: stored ? stored.prompt : content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"),
  attachments: stored?.attachments || content.filter((item: any) => ["image", "localImage", "audio", "localAudio"].includes(item.type)).map((item: any, index: number) => ({ id: item.id, name: item.path?.split("/").pop() || `Attachment ${index + 1}`, kind: item.type.toLowerCase().includes("audio") ? "audio" : "image", data: item.url?.startsWith("data:") ? item.url : undefined })),
});

async function processRss(pid?: number) {
  if (!pid || process.platform !== "linux") return null;
  try { const status = await nodeFs.readFile(`/proc/${pid}/status`, "utf8"); const value = status.match(/^VmRSS:\s+(\d+)\s+kB$/m); return value ? Number(value[1]) * 1024 : null; } catch { return null; }
}

export class CodexController {
  private pendingApprovals = new Map<string | number, { threadId?: string; item: any }>();
  private models: any[] = [];
  private startedAt: number | null = null;
  private lastError = "";
  private busy = false;
  private activeThreadId = "";
  private histories = new Map<string, any[]>();

  constructor(private codex: CodexClient, private fs: WorkspaceFs, private attachments: AttachmentStore, private events: EventHub, private meta: () => any) {
    codex.on("status", (status) => {
      if (status === "ready") { this.startedAt ||= Date.now(); this.lastError = ""; }
      this.events.push({ type: "status", ...this.meta(), codexStatus: status, runtime: this.runtime() });
    });
    codex.on("message", (message) => {
      if (message.method === "turn/started") this.busy = true;
      if (message.method === "turn/completed" || message.method === "error") this.busy = false;
      const request = approval(message);
      if (request) { this.pendingApprovals.set(request.requestId, { threadId: message.params?.threadId, item: request }); this.events.push({ type: "items", threadId: message.params?.threadId, items: [request] }); return; }
      if (message.method === "turn/completed" || message.method === "error") for (const [id, entry] of this.pendingApprovals) if (entry.threadId === message.params?.threadId) this.pendingApprovals.delete(id);
      const event = adapt(message); if (event) this.events.push({ type: "event", ...event });
    });
  }

  runtime() { return { status: this.codex.status, pid: this.codex.pid || null, busy: this.busy, startedAt: this.startedAt, lastError: this.lastError }; }

  async start() {
    try { await this.codex.ensureStarted(); this.startedAt = Date.now(); }
    catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  async bootstrap() {
    if (this.codex.status !== "ready") return { ready: false, stage: this.codex.status === "error" ? "error" : "starting", eventCursor: this.events.current, runtime: this.runtime(), meta: { ...this.meta(), codexStatus: this.codex.status } };
    const [modelResult, threadResult] = await Promise.all([
      this.models.length ? Promise.resolve({ data: this.models }) : this.codex.request("model/list", { limit: 50, includeHidden: false }),
      this.listThreads(false, null),
    ]);
    this.models = modelResult.data || this.models;
    return { ready: true, stage: "ready", eventCursor: this.events.current, runtime: this.runtime(), meta: { ...this.meta(), codexStatus: this.codex.status }, models: this.models, threads: (threadResult.data || []).map(threadSummary), nextCursor: threadResult.nextCursor || null };
  }

  private listThreads(archived: boolean, cursor: string | null) {
    return this.codex.request("thread/list", { limit: 50, cursor, sortKey: "updated_at", sortDirection: "desc", archived, sourceKinds });
  }

  private async threadItems(thread: any) {
    const result: any[] = []; const rawItems = (thread.turns || []).flatMap((turn: any) => (turn.items || []).map((item: any) => ({ turn, item }))).slice(-MAX_HISTORY_ITEMS);
    for (const { turn, item } of rawItems) {
      if (item.type === "userMessage") {
        let stored = await this.attachments.load(thread.id, item.id, turn.id);
        if (!stored) { const legacy = legacyMessage(item.content || []); if (legacy.attachments.length) try { stored = await this.attachments.save(thread.id, item.id, legacy.text, legacy.attachments); await this.attachments.setTurnId(thread.id, item.id, turn.id); } catch { /* keep original */ } }
        result.push({ type: "user_message", id: item.id, ...userMessage(item.content || [], stored) });
      } else { const mapped = adapt({ method: "item/completed", params: { threadId: thread.id, item } }); result.push(...(mapped?.items || [])); }
    }
    return result;
  }

  async handle(msg: any): Promise<any[]> {
    try {
      if (msg.type === "thread.list") { const result = await this.listThreads(Boolean(msg.archived), typeof msg.cursor === "string" ? msg.cursor : null); return [{ type: "threads", archived: Boolean(msg.archived), append: Boolean(msg.cursor), threads: (result.data || []).map(threadSummary), nextCursor: result.nextCursor || null }]; }
      if (msg.type === "model.list") { const result = await this.codex.request("model/list", { limit: 50, includeHidden: false }); this.models = result.data || []; return [{ type: "models", models: this.models }]; }
      if (msg.type === "thread.create") { if (!this.fs.isSelected) throw new Error("Choose a workspace before starting a thread"); const result = await this.codex.request("thread/start", { cwd: this.fs.path, model: msg.model || null, ...threadPermissionSettings(msg.permission), experimentalRawEvents: false }); this.activeThreadId = result.thread.id; this.histories.set(result.thread.id, []); const thread = threadSummary(result.thread); return [{ type: "thread.active", thread, workspace: this.meta(), items: [], historyCursor: 0, hasEarlier: false, model: result.model, effort: result.reasoningEffort }, { type: "thread.changed", thread }]; }
      if (msg.type === "thread.resume") { const result = await this.codex.request("thread/resume", { threadId: msg.threadId }); this.activeThreadId = result.thread.id; let workspaceError = ""; if (result.thread?.cwd) try { await this.fs.selectAbsolute(result.thread.cwd); } catch (error) { workspaceError = errorMessage(error); } const history = await this.threadItems(result.thread); this.histories.set(result.thread.id, history); const start = Math.max(0, history.length - HISTORY_PAGE_SIZE); const pending = [...this.pendingApprovals.values()].filter((entry) => entry.threadId === result.thread.id).map((entry) => entry.item); return [{ type: "thread.active", thread: threadSummary(result.thread), workspace: { ...this.meta(), error: workspaceError }, items: [...history.slice(start), ...pending], historyCursor: start, hasEarlier: start > 0, model: result.model, effort: result.reasoningEffort }]; }
      if (msg.type === "thread.history") { const history = this.histories.get(String(msg.threadId || "")) || []; const before = Math.min(history.length, Math.max(0, Number(msg.before) || 0)); const start = Math.max(0, before - HISTORY_PAGE_SIZE); return [{ type: "history.items", threadId: msg.threadId, items: history.slice(start, before), historyCursor: start, hasEarlier: start > 0 }]; }
      if (msg.type === "thread.archive") { await this.codex.request("thread/archive", { threadId: msg.threadId }); if (this.activeThreadId === msg.threadId) this.activeThreadId = ""; return [{ type: "thread.mutated", action: "archive", threadId: msg.threadId }]; }
      if (msg.type === "thread.unarchive") { const result = await this.codex.request("thread/unarchive", { threadId: msg.threadId }); return [{ type: "thread.mutated", action: "unarchive", threadId: msg.threadId, thread: threadSummary(result.thread) }]; }
      if (msg.type === "thread.delete") { await this.codex.request("thread/delete", { threadId: msg.threadId }); await this.attachments.removeThread(String(msg.threadId || "")); if (this.activeThreadId === msg.threadId) this.activeThreadId = ""; return [{ type: "thread.mutated", action: "delete", threadId: msg.threadId }]; }
      if (msg.type === "turn.send") {
        const text = String(msg.text || "").trim(); const inputs = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 4) : []; if (!text && !inputs.length) return [];
        const messageId = typeof msg.clientUserMessageId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(msg.clientUserMessageId) ? msg.clientUserMessageId : crypto.randomUUID();
        const persisted = inputs.length ? await this.attachments.save(String(msg.threadId || ""), messageId, text, inputs as IncomingAttachment[]) : null;
        const input: any[] = text ? [{ type: "text", text, text_elements: [] }] : [];
        for (const attachment of persisted?.prepared || []) input.push(attachment.kind === "image" ? { type: "image", url: attachment.dataUrl } : { type: "text", text: `Attached file \"${attachment.name}\":\n\n${attachment.text || ""}`, text_elements: [] });
        try { const result = await this.codex.request("turn/start", { threadId: msg.threadId, input, clientUserMessageId: messageId, model: msg.model || null, effort: msg.effort || null, ...turnPermissionSettings(msg.permission, this.fs.path), summary: "auto" }); if (persisted) await this.attachments.setTurnId(String(msg.threadId || ""), messageId, result.turn.id); return [{ type: "turn.accepted", turnId: result.turn.id, messageId, attachments: persisted?.attachments || [] }]; }
        catch (error) { if (persisted) await this.attachments.removeMessage(String(msg.threadId || ""), messageId); throw error; }
      }
      if (msg.type === "turn.interrupt") { await this.codex.request("turn/interrupt", { threadId: msg.threadId, turnId: msg.turnId }); return []; }
      if (msg.type === "approval.respond") { this.pendingApprovals.delete(msg.requestId); this.codex.respond(msg.requestId, { decision: msg.decision }); return []; }
      if (msg.type === "fs.list") return [{ type: "fs.entries", path: msg.path || "", entries: await this.fs.list(msg.path || "") }];
      if (msg.type === "fs.read") return [{ type: "fs.file", path: msg.path, file: await this.fs.read(msg.path) }];
      if (msg.type === "fs.write") return [{ type: "fs.saved", path: msg.path, file: await this.fs.write(msg.path, String(msg.content ?? "")) }];
      if (msg.type === "fs.create") return [{ type: "fs.created", requestId: msg.requestId, file: await this.fs.create(String(msg.directory || ""), String(msg.name || "")) }];
      if (msg.type === "fs.delete") return [{ type: "fs.deleted", requestId: msg.requestId, file: await this.fs.delete(String(msg.path || "")) }];
      if (msg.type === "fs.upload") return [{ type: "fs.uploaded", requestId: msg.requestId, file: await this.fs.upload(String(msg.directory || ""), String(msg.name || ""), String(msg.data || "")) }];
      if (msg.type === "workspace.list") return [{ type: "workspace.entries", path: msg.path || "", entries: await this.fs.listWorkspaces(msg.path || ""), base: this.fs.basePath, current: this.fs.path }];
      if (msg.type === "workspace.select") { const selected = await this.fs.select(msg.path || ""); return [{ type: "workspace.selected", ...selected, ...this.meta() }]; }
      if (msg.type === "system.usage") { const memory = process.memoryUsage(); const codexRss = await processRss(this.codex.pid); return [{ type: "system.usage", usage: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, heapLimit: v8.getHeapStatistics().heap_size_limit, external: memory.external, codexRss, totalRss: memory.rss + (codexRss || 0), uptime: process.uptime(), clients: 1 } }]; }
      if (msg.type === "account.usage") { const [usage, limits] = await Promise.allSettled([this.codex.request("account/usage/read"), this.codex.request("account/rateLimits/read")]); return [{ type: "account.usage", usage: usage.status === "fulfilled" ? usage.value : null, rateLimits: limits.status === "fulfilled" ? limits.value : null, unavailable: usage.status === "rejected" && limits.status === "rejected" }]; }
      if (msg.type === "runtime.restart") { const active = this.activeThreadId; await this.codex.stop(); this.startedAt = null; this.models = []; await this.start(); const boot = await this.bootstrap(); const restored = active ? await this.handle({ type: "thread.resume", threadId: active }) : []; return [{ type: "status", ...this.meta(), codexStatus: this.codex.status, runtime: this.runtime() }, { type: "models", models: boot.models || [] }, ...restored]; }
      if (msg.type === "runtime.stop") { await this.codex.stop(); return [{ type: "status", ...this.meta(), codexStatus: this.codex.status, runtime: this.runtime() }]; }
      if (msg.type === "runtime.start") { await this.start(); return [{ type: "status", ...this.meta(), codexStatus: this.codex.status, runtime: this.runtime() }]; }
      throw new Error(`Unsupported action: ${msg.type || "unknown"}`);
    } catch (error) {
      const message = errorMessage(error);
      if (msg.type === "fs.list") return [{ type: "fs.entries", path: msg.path || "", error: message }];
      if (msg.type === "fs.read") return [{ type: "fs.file", path: msg.path, error: message }];
      if (msg.type === "fs.write") return [{ type: "fs.saved", path: msg.path, error: message }];
      if (msg.type === "fs.upload") return [{ type: "fs.uploaded", requestId: msg.requestId, error: message }];
      if (msg.type === "fs.create") return [{ type: "fs.created", requestId: msg.requestId, error: message }];
      if (msg.type === "fs.delete") return [{ type: "fs.deleted", requestId: msg.requestId, error: message }];
      if (msg.type === "workspace.list") return [{ type: "workspace.entries", path: msg.path || "", entries: [], error: message, base: this.fs.basePath, current: this.fs.path }];
      return [{ type: "error", requestId: msg.requestId, message }];
    }
  }
}
