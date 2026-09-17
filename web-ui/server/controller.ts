import crypto from "node:crypto";
import nodeFs from "node:fs/promises";
import path from "node:path";
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
const WEB_UI_CONTEXT_PREFIX = "[Codex Web thread files]";
const AGENTS_START = "<!-- codex-web:thread-files:start -->";
const AGENTS_END = "<!-- codex-web:thread-files:end -->";
const AGENTS_SECTION = `${AGENTS_START}
For Codex Web turns, use the concrete .files/<thread.id>/ directory supplied in each turn for uploaded files and standalone files generated for the user. Keep them directly in that directory; do not create input, output, uploads, images, or scratch subdirectories unless the user explicitly asks for one. Keep tool-managed originals, report final paths, and respect an explicit user-specified destination. Do not move requested source-code edits, project files, or required build outputs away from their normal project paths. If saving an artifact fails, say so explicitly.
${AGENTS_END}`;
const threadDirectory = (threadId: string) => `.files/${threadId}/`;
const threadFileContext = (threadId: string, attachmentPaths: string[]) => `${WEB_UI_CONTEXT_PREFIX} This thread's ID is ${threadId}. Keep uploads and standalone files generated for this conversation directly in ${threadDirectory(threadId)} in the current project workspace; do not create input, output, uploads, images, or scratch subdirectories unless the user explicitly asks.${attachmentPaths.length ? ` This turn's uploaded files: ${attachmentPaths.map((file) => JSON.stringify(file)).join(", ")}. Read them from the workspace when needed.` : ""} Keep tool-managed originals and report final paths. Honor an explicit user-specified path. Keep requested project/source edits and required build outputs at their normal project paths. If saving an artifact fails, say so.`;
const visibleUserText = (value: unknown) => {
  const text = String(value || "");
  const marker = text.indexOf(WEB_UI_CONTEXT_PREFIX);
  return marker < 0 ? text : text.slice(0, marker).trimEnd();
};
async function ensureWorkspaceInstructions(cwd: string) {
  const file = path.join(cwd, "AGENTS.md");
  let current = "";
  try { if ((await nodeFs.lstat(file)).isSymbolicLink()) throw new Error("AGENTS.md cannot be a symlink"); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  try { current = await nodeFs.readFile(file, "utf8"); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const start = current.indexOf(AGENTS_START);
  const end = current.indexOf(AGENTS_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error("Incomplete Codex Web section in AGENTS.md");
  if (start >= 0) {
    const updated = `${current.slice(0, start)}${AGENTS_SECTION}${current.slice(end + AGENTS_END.length)}`;
    if (updated !== current) await nodeFs.writeFile(file, updated, "utf8");
    return;
  }
  await nodeFs.writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${AGENTS_SECTION}\n`, "utf8");
}
const timestampMs = (value: unknown) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? (number < 1e12 ? number * 1000 : number) : undefined; };
const lastTurnIndex = (items: any[], turnId: string) => { for (let index = items.length - 1; index >= 0; index--) if (items[index]?.turnId === turnId) return index; return -1; };
const threadSummary = (thread: any) => {
  if (!thread || typeof thread !== "object") return thread;
  const { turns: _turns, ...summary } = thread;
  if (typeof summary.preview === "string") summary.preview = visibleUserText(summary.preview);
  return summary;
};

const legacyAttachment = (value: unknown): IncomingAttachment | null => {
  if (typeof value !== "string" || !value.startsWith("Attached file \"")) return null;
  const marker = "\":\n\n"; const end = value.indexOf(marker, 15); if (end < 0) return null;
  const name = value.slice(15, end); return !name || name.length > 200 ? null : { name, mime: "text/plain", kind: "text", data: value.slice(end + marker.length) };
};
const legacyMessage = (content: any[]) => { const text: string[] = []; const attachments: IncomingAttachment[] = []; for (const item of content) { if (item.type !== "text" || String(item.text || "").startsWith(WEB_UI_CONTEXT_PREFIX)) continue; const attachment = legacyAttachment(item.text); attachment ? attachments.push(attachment) : text.push(visibleUserText(item.text)); } return { text: text.join("\n"), attachments }; };
const userMessage = (content: any[], stored?: { prompt: string; attachments: AttachmentSummary[] } | null) => ({
  text: visibleUserText(stored ? stored.prompt : content.filter((item: any) => item.type === "text" && !String(item.text || "").startsWith(WEB_UI_CONTEXT_PREFIX)).map((item: any) => item.text).join("\n")),
  attachments: stored?.attachments || content.filter((item: any) => ["image", "localImage", "audio", "localAudio"].includes(item.type)).map((item: any, index: number) => ({ id: item.id, name: item.path?.split("/").pop() || `Attachment ${index + 1}`, kind: item.type.toLowerCase().includes("audio") ? "audio" : "image", data: item.url?.startsWith("data:") ? item.url : undefined })),
});
const codexAttachmentInput = (attachment: any, filePath: string) => {
  if (attachment.kind === "image") return { type: "image", url: attachment.dataUrl };
  if (attachment.kind === "audio") return { type: "audio", url: attachment.dataUrl };
  if (attachment.kind === "text") return { type: "text", text: `Attached file \"${attachment.name}\":\n\n${attachment.text || ""}`, text_elements: [] };
  return { type: "text", text: `Attached binary file \"${attachment.name}\" (${attachment.mime}, ${attachment.size} bytes) is available at ${filePath}. Read it with a workspace tool if its contents are needed; do not infer its contents from the filename.`, text_elements: [] };
};
const runningTurn = (thread: any) => {
  const turn = thread?.turns?.at(-1);
  const running = thread?.status?.type === "active" || (!thread?.status && turn?.status === "inProgress");
  return { running, turnId: running && turn?.status === "inProgress" ? turn.id : undefined };
};

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
  private activeTurns = new Map<string, string>();
  private runningThreads = new Set<string>();
  private histories = new Map<string, any[]>();

  constructor(private codex: CodexClient, private fs: WorkspaceFs, private attachments: AttachmentStore, private events: EventHub, private meta: () => any) {
    codex.on("status", (status) => {
      if (status === "ready") { this.startedAt ||= Date.now(); this.lastError = ""; }
      this.events.push({ type: "status", ...this.meta(), codexStatus: status, runtime: this.runtime() });
    });
    codex.on("message", (message) => {
      const threadId = message.params?.threadId;
      if (threadId && message.method === "turn/started") { this.runningThreads.add(threadId); if (message.params?.turn?.id) this.activeTurns.set(threadId, message.params.turn.id); }
      if (threadId && (message.method === "turn/completed" || message.method === "error")) { this.runningThreads.delete(threadId); this.activeTurns.delete(threadId); }
      if (threadId && message.method === "thread/status/changed") { if (message.params?.status?.type === "active") this.runningThreads.add(threadId); else { this.runningThreads.delete(threadId); this.activeTurns.delete(threadId); } }
      this.busy = this.runningThreads.size > 0;
      const request = approval(message);
      if (request) { this.pendingApprovals.set(request.requestId, { threadId: message.params?.threadId, item: request }); this.events.push({ type: "items", threadId: message.params?.threadId, items: [request] }); return; }
      if (message.method === "turn/completed" || message.method === "error") for (const [id, entry] of this.pendingApprovals) if (entry.threadId === message.params?.threadId) this.pendingApprovals.delete(id);
      const event = adapt(message); if (event) { if (event.items) { const timestamp = timestampMs(message.params?.completedAtMs ?? message.params?.startedAtMs) || Date.now(); const turnId = event.turnId || message.params?.turnId || message.params?.turn?.id; event.items = event.items.map((item) => ({ ...item, timestamp: item.timestamp || timestamp, ...(turnId ? { turnId: item.turnId || turnId } : {}) })); } this.events.push({ type: "event", ...event }); }
    });
  }

  runtime() { return { status: this.codex.status, pid: this.codex.pid || null, busy: this.busy, startedAt: this.startedAt, lastError: this.lastError }; }

  async start() {
    try { await this.codex.ensureStarted(); this.startedAt = Date.now(); }
    catch (error) { this.lastError = errorMessage(error); throw error; }
  }

  async bootstrap() {
    if (this.codex.status !== "ready") return { ready: false, stage: this.codex.status === "error" ? "error" : "starting", eventCursor: this.events.current, runtime: this.runtime(), meta: { ...this.meta(), codexStatus: this.codex.status } };
    const eventCursor = this.events.current;
    const [modelResult, threadResult, defaults] = await Promise.all([
      this.models.length ? Promise.resolve({ data: this.models }) : this.codex.request("model/list", { limit: 50, includeHidden: false }),
      this.listThreads(false, null),
      this.readModelDefaults(),
    ]);
    this.models = modelResult.data || this.models;
    return { ready: true, stage: "ready", eventCursor, runtime: this.runtime(), meta: { ...this.meta(), codexStatus: this.codex.status }, models: this.models, ...defaults, threads: (threadResult.data || []).map(threadSummary), nextCursor: threadResult.nextCursor || null };
  }

  private async readModelDefaults(cwd?: string) {
    try {
      const result = await this.codex.request("config/read", { includeLayers: false, ...(cwd ? { cwd } : {}) });
      return { defaultModel: String(result?.config?.model || ""), defaultEffort: String(result?.config?.model_reasoning_effort || "") };
    } catch {
      return { defaultModel: "", defaultEffort: "" };
    }
  }

  private async listThreads(archived: boolean, cursor: string | null) {
    const result = await this.codex.request("thread/list", { limit: 50, cursor, sortKey: "updated_at", sortDirection: "desc", archived, sourceKinds });
    for (const thread of result.data || []) {
      if (thread.status?.type === "active") this.runningThreads.add(thread.id);
      else if (thread.status) { this.runningThreads.delete(thread.id); this.activeTurns.delete(thread.id); }
    }
    this.busy = this.runningThreads.size > 0;
    return result;
  }

  private async threadItems(thread: any, attachmentSources = new Map<string, string>()) {
    const result: any[] = []; const rawItems = (thread.turns || []).flatMap((turn: any) => (turn.items || []).map((item: any) => ({ turn, item }))).slice(-MAX_HISTORY_ITEMS);
    for (const { turn, item } of rawItems) {
      if (item.type === "userMessage") {
        let attachmentThreadId = thread.id; let stored = await this.attachments.load(thread.id, item.id, turn.id);
        if (!stored) { const source = attachmentSources.get(item.id) || thread.forkedFromId; if (source) { stored = await this.attachments.load(source, item.id, turn.id); if (stored) attachmentThreadId = source; } }
        if (!stored) { const legacy = legacyMessage(item.content || []); if (legacy.attachments.length) try { stored = await this.attachments.save(thread.id, item.id, legacy.text, legacy.attachments); await this.attachments.setTurnId(thread.id, item.id, turn.id); } catch { /* keep original */ } }
        result.push({ type: "user_message", id: item.id, turnId: turn.id, timestamp: timestampMs(turn.startedAt), ...userMessage(item.content || [], stored), ...(stored ? { attachmentThreadId } : {}) });
      } else { const mapped = adapt({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } }); const timestamp = timestampMs(turn.completedAt ?? turn.startedAt); result.push(...(mapped?.items || []).map((entry) => ({ ...entry, turnId: turn.id, timestamp }))); }
    }
    return result;
  }

  async handle(msg: any): Promise<any[]> {
    try {
      if (msg.type === "thread.list") { const result = await this.listThreads(Boolean(msg.archived), typeof msg.cursor === "string" ? msg.cursor : null); return [{ type: "threads", archived: Boolean(msg.archived), append: Boolean(msg.cursor), threads: (result.data || []).map(threadSummary), nextCursor: result.nextCursor || null }]; }
      if (msg.type === "model.list") { const [result, defaults] = await Promise.all([this.codex.request("model/list", { limit: 50, includeHidden: false }), this.readModelDefaults(this.fs.isSelected ? this.fs.path : undefined)]); this.models = result.data || []; return [{ type: "models", models: this.models, ...defaults }]; }
      if (msg.type === "thread.create") { if (!this.fs.isSelected) throw new Error("Choose a workspace before starting a thread"); if (msg.permission !== "read-only") await ensureWorkspaceInstructions(this.fs.path); const result = await this.codex.request("thread/start", { cwd: this.fs.path, model: msg.model || null, ...threadPermissionSettings(msg.permission), experimentalRawEvents: false }); this.attachments.bindThread(result.thread.id, result.thread.cwd || this.fs.path); this.activeThreadId = result.thread.id; this.histories.set(result.thread.id, []); const thread = threadSummary(result.thread); return [{ type: "thread.active", thread, workspace: this.meta(), items: [], historyCursor: 0, hasEarlier: false, model: result.model, effort: result.reasoningEffort }, { type: "thread.changed", thread }]; }
      if (msg.type === "thread.resume") {
        const result = await this.codex.request("thread/resume", { threadId: msg.threadId });
        this.activeThreadId = result.thread.id;
        let workspaceError = "";
        if (result.thread?.cwd) try { await this.fs.selectAbsolute(result.thread.cwd); this.attachments.bindThread(result.thread.id, this.fs.path); } catch (error) { workspaceError = errorMessage(error); }
        const history = await this.threadItems(result.thread);
        this.histories.set(result.thread.id, history);
        const start = Math.max(0, history.length - HISTORY_PAGE_SIZE);
        const pending = [...this.pendingApprovals.values()].filter((entry) => entry.threadId === result.thread.id).map((entry) => entry.item);
        const turn = runningTurn(result.thread);
        if (turn.running) this.runningThreads.add(result.thread.id); else { this.runningThreads.delete(result.thread.id); this.activeTurns.delete(result.thread.id); }
        if (turn.turnId) this.activeTurns.set(result.thread.id, turn.turnId);
        this.busy = this.runningThreads.size > 0;
        return [{ type: "thread.active", thread: threadSummary(result.thread), running: turn.running, turnId: this.activeTurns.get(result.thread.id), workspace: { ...this.meta(), error: workspaceError }, items: [...history.slice(start), ...pending], historyCursor: start, hasEarlier: start > 0, model: result.model, effort: result.reasoningEffort }];
      }
      if (msg.type === "thread.fork") { const lastTurnId = typeof msg.turnId === "string" ? msg.turnId.trim() : ""; if (!lastTurnId) throw new Error("Choose a Codex response to branch from"); const sourceHistory = this.histories.get(String(msg.threadId || "")) || []; const boundary = lastTurnIndex(sourceHistory, lastTurnId); const branchHistory = boundary >= 0 ? sourceHistory.slice(0, boundary + 1) : sourceHistory; const attachmentSources = new Map(branchHistory.filter((item) => item.type === "user_message" && item.attachmentThreadId).map((item) => [item.id, item.attachmentThreadId])); const result = await this.codex.request("thread/fork", { threadId: msg.threadId, lastTurnId, excludeTurns: false }); this.activeThreadId = result.thread.id; let workspaceError = ""; if (result.thread?.cwd) try { await this.fs.selectAbsolute(result.thread.cwd); this.attachments.bindThread(result.thread.id, this.fs.path); } catch (error) { workspaceError = errorMessage(error); } await Promise.allSettled(branchHistory.filter((item) => item.type === "user_message" && item.attachments?.length).map((item) => this.attachments.cloneMessage(item.attachmentThreadId || msg.threadId, result.thread.id, item.id))); const history = await this.threadItems(result.thread, attachmentSources); this.histories.set(result.thread.id, history); const start = Math.max(0, history.length - HISTORY_PAGE_SIZE); const thread = threadSummary(result.thread); return [{ type: "thread.active", thread, workspace: { ...this.meta(), error: workspaceError }, items: history.slice(start), historyCursor: start, hasEarlier: start > 0, model: result.model, effort: result.reasoningEffort }, { type: "thread.changed", thread }]; }
      if (msg.type === "thread.history") { const history = this.histories.get(String(msg.threadId || "")) || []; const before = Math.min(history.length, Math.max(0, Number(msg.before) || 0)); const start = Math.max(0, before - HISTORY_PAGE_SIZE); return [{ type: "history.items", threadId: msg.threadId, items: history.slice(start, before), historyCursor: start, hasEarlier: start > 0 }]; }
      if (msg.type === "thread.archive") { await this.codex.request("thread/archive", { threadId: msg.threadId }); if (this.activeThreadId === msg.threadId) this.activeThreadId = ""; return [{ type: "thread.mutated", action: "archive", threadId: msg.threadId }]; }
      if (msg.type === "thread.unarchive") { const result = await this.codex.request("thread/unarchive", { threadId: msg.threadId }); return [{ type: "thread.mutated", action: "unarchive", threadId: msg.threadId, thread: threadSummary(result.thread) }]; }
      if (msg.type === "thread.delete") { await this.codex.request("thread/delete", { threadId: msg.threadId }); await this.attachments.removeThread(String(msg.threadId || "")); if (this.activeThreadId === msg.threadId) this.activeThreadId = ""; return [{ type: "thread.mutated", action: "delete", threadId: msg.threadId }]; }
      if (msg.type === "turn.send") {
        const text = String(msg.text || "").trim(); const inputs = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 4) : []; if (!text && !inputs.length) return [];
        const threadId = String(msg.threadId || "");
        if (this.runningThreads.has(threadId) || this.activeTurns.has(threadId)) throw new Error("This thread is still running; stop or wait for the current turn");
        const cwd = this.attachments.workspaceFor(threadId);
        if (!cwd) throw new Error("Thread workspace is unavailable; resume the thread before sending");
        const messageId = typeof msg.clientUserMessageId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(msg.clientUserMessageId) ? msg.clientUserMessageId : crypto.randomUUID();
        const persisted = inputs.length ? await this.attachments.save(threadId, messageId, text, inputs as IncomingAttachment[]) : null;
        const input: any[] = text ? [{ type: "text", text, text_elements: [] }] : [];
        const attachmentPaths = persisted?.paths || [];
        for (const [index, attachment] of (persisted?.prepared || []).entries()) input.push(codexAttachmentInput(attachment, attachmentPaths[index]));
        input.push({ type: "text", text: threadFileContext(threadId, attachmentPaths), text_elements: [] });
        try { const result = await this.codex.request("turn/start", { threadId, input, clientUserMessageId: messageId, model: msg.model || null, effort: msg.effort || null, ...turnPermissionSettings(msg.permission, cwd), summary: "auto" }); this.runningThreads.add(threadId); this.activeTurns.set(threadId, result.turn.id); this.busy = true; if (persisted) await this.attachments.setTurnId(threadId, messageId, result.turn.id); return [{ type: "turn.accepted", threadId, turnId: result.turn.id, messageId, attachments: persisted?.attachments || [] }]; }
        catch (error) { if (persisted) await this.attachments.removeMessage(threadId, messageId); throw error; }
      }
      if (msg.type === "turn.interrupt") { const turnId = msg.turnId || this.activeTurns.get(String(msg.threadId || "")); if (!turnId) throw new Error("Active turn ID is unavailable; reopen the thread and try again"); await this.codex.request("turn/interrupt", { threadId: msg.threadId, turnId }); return []; }
      if (msg.type === "approval.respond") { this.pendingApprovals.delete(msg.requestId); this.codex.respond(msg.requestId, { decision: msg.decision }); return []; }
      if (msg.type === "fs.list") return [{ type: "fs.entries", path: msg.path || "", entries: await this.fs.list(msg.path || "") }];
      if (msg.type === "fs.read") return [{ type: "fs.file", path: msg.path, file: await this.fs.read(msg.path) }];
      if (msg.type === "fs.write") return [{ type: "fs.saved", path: msg.path, file: await this.fs.write(msg.path, String(msg.content ?? "")) }];
      if (msg.type === "fs.create") return [{ type: "fs.created", requestId: msg.requestId, file: await this.fs.create(String(msg.directory || ""), String(msg.name || "")) }];
      if (msg.type === "fs.delete") return [{ type: "fs.deleted", requestId: msg.requestId, file: await this.fs.delete(String(msg.path || "")) }];
      if (msg.type === "fs.upload") return [{ type: "fs.uploaded", requestId: msg.requestId, file: await this.fs.upload(String(msg.directory || ""), String(msg.name || ""), String(msg.data || "")) }];
      if (msg.type === "workspace.list") return [{ type: "workspace.entries", path: msg.path || "", entries: await this.fs.listWorkspaces(msg.path || ""), base: this.fs.basePath, current: this.fs.path }];
      if (msg.type === "workspace.select") { const selected = await this.fs.select(msg.path || ""); const defaults = await this.readModelDefaults(this.fs.path); return [{ type: "workspace.selected", ...selected, ...this.meta(), ...defaults }]; }
      if (msg.type === "system.usage") { const memory = process.memoryUsage(); const codexRss = await processRss(this.codex.pid); return [{ type: "system.usage", usage: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, heapLimit: v8.getHeapStatistics().heap_size_limit, external: memory.external, codexRss, totalRss: memory.rss + (codexRss || 0), uptime: process.uptime(), clients: 1 } }]; }
      if (msg.type === "account.usage") { const [usage, limits] = await Promise.allSettled([this.codex.request("account/usage/read"), this.codex.request("account/rateLimits/read")]); return [{ type: "account.usage", usage: usage.status === "fulfilled" ? usage.value : null, rateLimits: limits.status === "fulfilled" ? limits.value : null, unavailable: usage.status === "rejected" && limits.status === "rejected" }]; }
      if (msg.type === "runtime.restart") { const active = this.activeThreadId; await this.codex.stop(); this.startedAt = null; this.models = []; await this.start(); const boot: any = await this.bootstrap(); const restored = active ? await this.handle({ type: "thread.resume", threadId: active }) : []; return [{ type: "status", ...this.meta(), codexStatus: this.codex.status, runtime: this.runtime() }, { type: "models", models: boot.models || [], defaultModel: boot.defaultModel || "", defaultEffort: boot.defaultEffort || "" }, ...restored]; }
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
