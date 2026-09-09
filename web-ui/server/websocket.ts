import type { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";
import nodeFs from "node:fs/promises";
import v8 from "node:v8";
import { adapt, approval } from "./codex/event-adapter.js";
import { AttachmentStore, type AttachmentSummary, type IncomingAttachment } from "./attachments.js";
import type { CodexClient } from "./codex/client.js";
import type { WorkspaceFs } from "./filesystem.js";

const send = (socket: WebSocket, data: any) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(data));
const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
const threadPermissionSettings = (permission: unknown) => {
  switch (permission) {
    case "full": return { approvalPolicy: "never", sandbox: "danger-full-access" };
    case "read-only": return { approvalPolicy: "on-request", sandbox: "read-only" };
    default: return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
};
const turnPermissionSettings = (permission: unknown, cwd: string) => {
  switch (permission) {
    case "full": return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    case "read-only": return { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    default: return { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
  }
};
const legacyAttachment = (value: unknown): IncomingAttachment | null => {
  if (typeof value !== "string" || !value.startsWith("Attached file \"")) return null;
  const marker = "\":\n\n";
  const end = value.indexOf(marker, 15);
  if (end < 0) return null;
  const name = value.slice(15, end);
  if (!name || name.length > 200) return null;
  return { name, mime: "text/plain", kind: "text", data: value.slice(end + marker.length) };
};
const legacyMessage = (content: any[]) => {
  const text: string[] = []; const attachments: IncomingAttachment[] = [];
  for (const item of content) {
    if (item.type !== "text") continue;
    const attachment = legacyAttachment(item.text);
    if (attachment) attachments.push(attachment); else text.push(String(item.text || ""));
  }
  return { text: text.join("\n"), attachments };
};
const userMessage = (content: any[], stored?: { prompt: string; attachments: AttachmentSummary[] } | null) => ({
  text: stored ? stored.prompt : content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"),
  attachments: stored?.attachments || content.filter((item: any) => ["image", "localImage", "audio", "localAudio"].includes(item.type)).map((item: any, index: number) => ({ id: item.id, name: item.path?.split("/").pop() || `${item.type.startsWith("audio") || item.type === "localAudio" ? "Audio" : "Image"} ${index + 1}`, kind: item.type.startsWith("audio") || item.type === "localAudio" ? "audio" : "image", data: item.url?.startsWith("data:") ? item.url : undefined })),
});
async function processRss(pid?: number) {
  if (!pid || process.platform !== "linux") return null;
  try { const status = await nodeFs.readFile(`/proc/${pid}/status`, "utf8"); const value = status.match(/^VmRSS:\s+(\d+)\s+kB$/m); return value ? Number(value[1]) * 1024 : null; } catch { return null; }
}
async function allThreads(codex: CodexClient, archived: boolean) {
  const threads: any[] = []; let cursor: string | null | undefined; let pages = 0;
  do {
    const result = await codex.request("thread/list", { limit: 100, cursor: cursor || null, sortKey: "updated_at", sortDirection: "desc", archived, sourceKinds });
    threads.push(...(result.data || [])); cursor = result.nextCursor; pages++;
  } while (cursor && pages < 100);
  return threads;
}
const threadItems = async (thread: any, attachmentStore: AttachmentStore) => {
  const result: any[] = [];
  for (const turn of thread.turns || []) for (const item of turn.items || []) {
    if (item.type === "userMessage") {
      let stored = await attachmentStore.load(thread.id, item.id, turn.id);
      if (!stored) {
        const legacy = legacyMessage(item.content || []);
        if (legacy.attachments.length) {
          try {
            const migrated = await attachmentStore.save(thread.id, item.id, legacy.text, legacy.attachments);
            try { await attachmentStore.setTurnId(thread.id, item.id, turn.id); } catch { /* The recovered manifest is still usable by message ID. */ }
            stored = migrated;
          } catch { /* Keep the original text visible if a legacy attachment cannot be migrated. */ }
        }
      }
      result.push({ type: "user_message", id: item.id, ...userMessage(item.content || [], stored) });
    } else {
      const mapped = adapt({ method: "item/completed", params: { threadId: thread.id, item } });
      result.push(...(mapped?.items || []));
    }
  }
  return result;
};

export function wireSockets(wss: WebSocketServer, codex: CodexClient, fs: WorkspaceFs, attachmentStore: AttachmentStore, meta: any) {
  const clients = new Set<WebSocket>();
  const pendingApprovals = new Map<string | number, { threadId?: string; item: any }>();
  const broadcast = (data: any) => clients.forEach((socket) => send(socket, data));
  codex.on("status", (status) => broadcast({ type: "status", ...meta(), codexStatus: status }));
  codex.on("message", (message) => {
    const request = approval(message);
    if (request) { pendingApprovals.set(request.requestId, { threadId: message.params?.threadId, item: request }); return broadcast({ type: "items", threadId: message.params?.threadId, items: [request] }); }
    if (message.method === "turn/completed" || message.method === "error") for (const [id, entry] of pendingApprovals) if (entry.threadId === message.params?.threadId) pendingApprovals.delete(id);
    const event = adapt(message); if (event) broadcast({ type: "event", ...event });
  });

  wss.on("connection", (socket) => {
    clients.add(socket); send(socket, { type: "status", ...meta(), codexStatus: codex.status });
    socket.on("close", () => clients.delete(socket));
    socket.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "thread.list") {
          send(socket, { type: "threads", archived: Boolean(msg.archived), threads: await allThreads(codex, Boolean(msg.archived)) });
        } else if (msg.type === "model.list") {
          const result = await codex.request("model/list", { limit: 50, includeHidden: false });
          send(socket, { type: "models", models: result.data || [] });
        } else if (msg.type === "thread.create") {
          if (!fs.isSelected) throw new Error("Choose a workspace before starting a thread");
          const result = await codex.request("thread/start", { cwd: fs.path, model: msg.model || null, ...threadPermissionSettings(msg.permission), experimentalRawEvents: false });
          send(socket, { type: "thread.active", thread: result.thread, items: [], model: result.model, effort: result.reasoningEffort }); broadcast({ type: "thread.changed", thread: result.thread });
        } else if (msg.type === "thread.resume") {
          const result = await codex.request("thread/resume", { threadId: msg.threadId });
          if (result.thread?.cwd) {
            try { await fs.selectAbsolute(result.thread.cwd); broadcast({ type: "status", ...meta(), codexStatus: codex.status }); } catch { /* The session can still be viewed outside the file-browser root. */ }
          }
          const pending = [...pendingApprovals.values()].filter((entry) => entry.threadId === result.thread.id).map((entry) => entry.item);
          send(socket, { type: "thread.active", thread: result.thread, items: [...await threadItems(result.thread, attachmentStore), ...pending], model: result.model, effort: result.reasoningEffort });
        } else if (msg.type === "thread.archive") {
          await codex.request("thread/archive", { threadId: msg.threadId });
          broadcast({ type: "thread.mutated", action: "archive", threadId: msg.threadId });
        } else if (msg.type === "thread.unarchive") {
          const result = await codex.request("thread/unarchive", { threadId: msg.threadId });
          broadcast({ type: "thread.mutated", action: "unarchive", threadId: msg.threadId, thread: result.thread });
        } else if (msg.type === "thread.delete") {
          await codex.request("thread/delete", { threadId: msg.threadId });
          await attachmentStore.removeThread(String(msg.threadId || ""));
          broadcast({ type: "thread.mutated", action: "delete", threadId: msg.threadId });
        } else if (msg.type === "turn.send") {
          const text = String(msg.text || "").trim(); const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 4) : []; if (!text && !attachments.length) return;
          const messageId = typeof msg.clientUserMessageId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(msg.clientUserMessageId) ? msg.clientUserMessageId : crypto.randomUUID();
          const persisted = attachments.length ? await attachmentStore.save(String(msg.threadId || ""), messageId, text, attachments as IncomingAttachment[]) : null;
          const input: any[] = text ? [{ type: "text", text, text_elements: [] }] : [];
          for (const attachment of persisted?.prepared || []) {
            if (attachment.kind === "image") input.push({ type: "image", url: attachment.dataUrl });
            else input.push({ type: "text", text: `Attached file \"${attachment.name}\":\n\n${attachment.text || ""}`, text_elements: [] });
          }
          try {
            const result = await codex.request("turn/start", { threadId: msg.threadId, input, clientUserMessageId: messageId, model: msg.model || null, effort: msg.effort || null, ...turnPermissionSettings(msg.permission, fs.path), summary: "auto" });
            if (persisted) { try { await attachmentStore.setTurnId(String(msg.threadId || ""), messageId, result.turn.id); } catch { /* The turn is already accepted; metadata can still be recovered by message ID. */ } }
            send(socket, { type: "turn.accepted", turnId: result.turn.id, messageId, attachments: persisted?.attachments || [] });
          } catch (error) {
            if (persisted) await attachmentStore.removeMessage(String(msg.threadId || ""), messageId);
            throw error;
          }
        } else if (msg.type === "turn.interrupt") await codex.request("turn/interrupt", { threadId: msg.threadId, turnId: msg.turnId });
        else if (msg.type === "approval.respond") { pendingApprovals.delete(msg.requestId); codex.respond(msg.requestId, { decision: msg.decision }); }
        else if (msg.type === "fs.list") { try { send(socket, { type: "fs.entries", path: msg.path || "", entries: await fs.list(msg.path || "") }); } catch (error) { send(socket, { type: "fs.entries", path: msg.path || "", error: error instanceof Error ? error.message : String(error) }); } }
        else if (msg.type === "fs.read") { try { send(socket, { type: "fs.file", path: msg.path, file: await fs.read(msg.path) }); } catch (error) { send(socket, { type: "fs.file", path: msg.path, error: error instanceof Error ? error.message : String(error) }); } }
        else if (msg.type === "fs.write") { try { send(socket, { type: "fs.saved", path: msg.path, file: await fs.write(msg.path, String(msg.content ?? "")) }); } catch (error) { send(socket, { type: "fs.saved", path: msg.path, error: error instanceof Error ? error.message : String(error) }); } }
        else if (msg.type === "fs.create") { try { send(socket, { type: "fs.created", requestId: msg.requestId, file: await fs.create(String(msg.directory || ""), String(msg.name || "")) }); } catch (error) { send(socket, { type: "fs.created", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) }); } }
        else if (msg.type === "fs.delete") { try { send(socket, { type: "fs.deleted", requestId: msg.requestId, file: await fs.delete(String(msg.path || "")) }); } catch (error) { send(socket, { type: "fs.deleted", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) }); } }
        else if (msg.type === "fs.upload") {
          try {
            const file = await fs.upload(String(msg.directory || ""), String(msg.name || ""), String(msg.data || ""));
            send(socket, { type: "fs.uploaded", requestId: msg.requestId, file });
          } catch (error) { send(socket, { type: "fs.uploaded", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) }); }
        }
        else if (msg.type === "workspace.list") send(socket, { type: "workspace.entries", path: msg.path || "", entries: await fs.listWorkspaces(msg.path || ""), base: fs.basePath, current: fs.path });
        else if (msg.type === "system.usage") {
          const memory = process.memoryUsage(); const codexRss = await processRss(codex.pid);
          send(socket, { type: "system.usage", usage: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, heapLimit: v8.getHeapStatistics().heap_size_limit, external: memory.external, codexRss, totalRss: memory.rss + (codexRss || 0), uptime: process.uptime(), clients: clients.size } });
        } else if (msg.type === "account.usage") {
          const [usage, limits] = await Promise.allSettled([codex.request("account/usage/read"), codex.request("account/rateLimits/read")]);
          send(socket, { type: "account.usage", usage: usage.status === "fulfilled" ? usage.value : null, rateLimits: limits.status === "fulfilled" ? limits.value : null, unavailable: usage.status === "rejected" && limits.status === "rejected" });
        }
        else if (msg.type === "workspace.select") {
          const selected = await fs.select(msg.path || "");
          send(socket, { type: "workspace.selected", ...selected, ...meta() });
          broadcast({ type: "status", ...meta(), codexStatus: codex.status });
        }
      } catch (error) { send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }); }
    });
  });
}
