import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, GitCompareArrows, Menu, PanelLeftOpen, Settings2 } from "lucide-react";
import { Composer, type ComposerAttachment, type PermissionPreset } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { DiffDrawer } from "./components/DiffDrawer";
import { FileDrawer } from "./components/FileDrawer";
import { Sidebar } from "./components/Sidebar";
import { SettingsDrawer, type CompactionStatus, type ResourceUsage, type ThreadUsage } from "./components/SettingsDrawer";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { demoItems, demoThreads } from "./demo";
import { useSocket } from "./hooks/useSocket";
import type { ApprovalDecision, FileEntry, ModelOption, Thread, UiItem } from "./types";

const demo = new URLSearchParams(location.search).has("demo");
const initialFile = new URLSearchParams(location.search).get("file") || "";
const initialSession = new URLSearchParams(location.search).get("session") || "";
const browserBasePath = location.pathname.replace(/\/$/, "") || "/";
const updateSessionUrl = (id?: string) => { const url = new URL(location.href); if (id) url.searchParams.set("session", id); else url.searchParams.delete("session"); history.replaceState(null, "", url); };
const approvalDecisionKey = (decision: ApprovalDecision) => typeof decision === "string" ? decision : Object.keys(decision)[0] || "";
const demoModels: ModelOption[] = [
  { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Frontier coding model for complex, long-running work", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning` })) },
  { id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Fast, balanced model for everyday coding", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning` })) },
];
const mergeItems = (current: UiItem[], incoming: UiItem[]) => {
  const next = [...current];
  for (const item of incoming) {
    const index = next.findIndex((entry) => entry.id === item.id);
    if (index < 0) next.push(item);
    else if (item.type === "assistant_message" && next[index].type === "assistant_message" && item.streaming) next[index] = { ...item, text: item.text.startsWith(next[index].text) ? item.text : next[index].text + item.text };
    else if (item.type === "thinking" && next[index].type === "thinking" && item.status === "running") next[index] = { ...item, text: next[index].text + item.text };
    else if (item.type === "command" && next[index].type === "command" && item.status === "running" && !item.command) next[index] = { ...next[index], output: next[index].output + item.output };
    else next[index] = { ...next[index], ...item } as UiItem;
  }
  return next;
};
const diffFromItems = (value: UiItem[]) => value.filter((item): item is Extract<UiItem, { type: "file_change" }> => item.type === "file_change" && Boolean(item.diff)).map((item) => /^(diff --git|--- )/m.test(item.diff || "") ? item.diff : `diff --git a/${item.path} b/${item.path}\n--- a/${item.path}\n+++ b/${item.path}\n${item.diff}`).join("\n");
const displayAttachment = (item: ComposerAttachment) => ({ id: item.id, name: item.name, mime: item.mime, kind: item.kind, size: item.size, data: item.kind === "image" ? item.data : undefined });
const editDiff = (path: string, before: string, after: string) => {
  const oldLines = before.split("\n"); const newLines = after.split("\n");
  let prefix = 0; while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0; while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const contextStart = Math.max(0, prefix - 2); const oldEnd = oldLines.length - suffix; const newEnd = newLines.length - suffix; const contextEnd = Math.min(oldLines.length, oldEnd + 2);
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -${contextStart + 1},${contextEnd - contextStart} +${contextStart + 1},${newEnd + (contextEnd - oldEnd) - contextStart} @@`];
  lines.push(...oldLines.slice(contextStart, prefix).map((line) => ` ${line}`), ...oldLines.slice(prefix, oldEnd).map((line) => `-${line}`), ...newLines.slice(prefix, newEnd).map((line) => `+${line}`), ...oldLines.slice(oldEnd, contextEnd).map((line) => ` ${line}`));
  return lines.join("\n");
};

export function App() {
  const [threads, setThreads] = useState<Thread[]>(demo ? demoThreads : []);
  const [archivedThreads, setArchivedThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<Thread | null>(demo ? demoThreads[0] : null);
  const activeRef = useRef(active); activeRef.current = active;
  const [items, setItems] = useState<UiItem[]>(demo ? demoItems : []);
  const [diff, setDiff] = useState(demo ? diffFromItems(demoItems) : "");
  const [models, setModels] = useState<ModelOption[]>(demo ? demoModels : []);
  const [model, setModel] = useState(demo ? demoModels[0].model : "");
  const [effort, setEffort] = useState(demo ? demoModels[0].defaultReasoningEffort : "");
  const [permission, setPermission] = useState<PermissionPreset>("ask");
  const modelRef = useRef(model); modelRef.current = model;
  const effortRef = useRef(effort); effortRef.current = effort;
  const [running, setRunning] = useState(false); const [turnId, setTurnId] = useState<string>();
  const [scrollRequest, setScrollRequest] = useState(0);
  const [sidebar, setSidebar] = useState(false); const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [files, setFiles] = useState(false); const [fileTarget, setFileTarget] = useState(initialFile); const [settings, setSettings] = useState(false); const [changes, setChanges] = useState(false); const [workspacePicker, setWorkspacePicker] = useState(false);
  const [meta, setMeta] = useState({ workspace: demo ? "/home/demo/project" : "", workspaceBase: demo ? "/home/demo" : "", workspaceSelected: demo, basePath: demo ? browserBasePath : "/", codexStatus: demo ? "ready" : "starting", codexVersion: "Codex" });
  const [resources, setResources] = useState<ResourceUsage | null>(demo ? { rss: 74e6, heapUsed: 19e6, heapTotal: 34e6, heapLimit: 268e6, external: 3e6, codexRss: 103e6, totalRss: 177e6, uptime: 8240, clients: 1 } : null);
  const [account, setAccount] = useState<any>(demo ? { usage: { summary: { lifetimeTokens: 1824500, peakDailyTokens: 64200, longestRunningTurnSec: 481, currentStreakDays: 9 } }, rateLimits: { rateLimits: { limitId: "codex", primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 7200 }, secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 172800 } } } } : null);
  const [threadUsage, setThreadUsage] = useState<ThreadUsage | null>(demo ? { total: { totalTokens: 48210, inputTokens: 42000, cachedInputTokens: 31000, outputTokens: 6210, reasoningOutputTokens: 2400 }, last: { totalTokens: 13800, inputTokens: 11200, cachedInputTokens: 8300, outputTokens: 2600, reasoningOutputTokens: 980 }, modelContextWindow: 114688 } : null); const [compaction, setCompaction] = useState<CompactionStatus>(demo ? { status: "completed", at: Date.now() - 3600000 } : null);
  const pending = useRef(new Map<string, (value: any) => void>());
  const queuedPrompt = useRef<{ id: string; text: string; attachments: ComposerAttachment[] } | null>(null);
  const sessionToResume = useRef(initialSession);

  const onMessage = useCallback((message: any) => {
    if (message.type === "status") setMeta((old) => ({ ...old, ...message }));
    else if (message.type === "threads") {
      if (message.archived) setArchivedThreads(message.threads);
      else setThreads(message.threads);
    } else if (message.type === "models") {
      setModels(message.models); const preferred = message.models.find((item: ModelOption) => item.isDefault) || message.models[0];
      setModel((current) => current || preferred?.model || ""); setEffort((current) => current || preferred?.defaultReasoningEffort || "");
    } else if (message.type === "thread.active") {
      const nextItems = message.items || []; const queued = queuedPrompt.current;
      setActive(message.thread); updateSessionUrl(message.thread.id); setItems(queued ? [{ type: "user_message", id: queued.id, text: queued.text, attachments: queued.attachments.map(displayAttachment) }] : nextItems); setDiff(diffFromItems(nextItems)); setThreadUsage(null); setCompaction(message.compaction || null); setRunning(Boolean(queued));
      if (message.model) setModel(message.model); if (message.effort) setEffort(message.effort);
      if (queued) { queuedPrompt.current = null; sendRef.current({ type: "turn.send", threadId: message.thread.id, clientUserMessageId: queued.id, text: queued.text, attachments: queued.attachments, model: modelRef.current, effort: effortRef.current }); }
    } else if (message.type === "thread.changed") setThreads((old) => [message.thread, ...old.filter((entry) => entry.id !== message.thread.id)]);
    else if (message.type === "thread.mutated") {
      setThreads((old) => old.filter((entry) => entry.id !== message.threadId)); setArchivedThreads((old) => old.filter((entry) => entry.id !== message.threadId));
      if (activeRef.current?.id === message.threadId && message.action !== "unarchive") { setActive(null); updateSessionUrl(); setItems([]); setDiff(""); setThreadUsage(null); setCompaction(null); }
      sendRef.current({ type: "thread.list" }); sendRef.current({ type: "thread.list", archived: true });
    } else if (message.type === "items") setItems((old) => mergeItems(old, message.items));
    else if (message.type === "event" && (!message.threadId || message.threadId === activeRef.current?.id)) {
      if (message.items) setItems((old) => mergeItems(old, message.items)); if (message.diff !== undefined) setDiff(message.diff); if (message.tokenUsage) setThreadUsage(message.tokenUsage); if (message.compaction) setCompaction(message.compaction); if (message.running !== undefined) setRunning(message.running); if (message.turnId) setTurnId(message.turnId);
    } else if (message.type === "turn.accepted") {
      setTurnId(message.turnId); setRunning(true);
      if (message.messageId && Array.isArray(message.attachments)) setItems((old) => old.map((item) => {
        if (item.type !== "user_message" || item.id !== message.messageId) return item;
        const current = new Map((item.attachments || []).map((attachment) => [attachment.id, attachment]));
        return { ...item, attachments: message.attachments.map((attachment: any) => ({ ...attachment, data: attachment.kind === "image" ? current.get(attachment.id)?.data : undefined })) };
      }));
    }
    else if (message.type === "fs.entries") { pending.current.get(`list:${message.path}`)?.(message); pending.current.delete(`list:${message.path}`); }
    else if (message.type === "fs.file") { pending.current.get(`read:${message.path || message.file?.path}`)?.(message); pending.current.delete(`read:${message.path || message.file?.path}`); }
    else if (message.type === "fs.saved") { pending.current.get(`write:${message.path || message.file?.path}`)?.(message); pending.current.delete(`write:${message.path || message.file?.path}`); }
    else if (message.type === "fs.uploaded") { pending.current.get(`upload:${message.requestId}`)?.(message); pending.current.delete(`upload:${message.requestId}`); }
    else if (message.type === "fs.created") { pending.current.get(`create:${message.requestId}`)?.(message); pending.current.delete(`create:${message.requestId}`); }
    else if (message.type === "fs.deleted") { pending.current.get(`delete:${message.requestId}`)?.(message); pending.current.delete(`delete:${message.requestId}`); }
    else if (message.type === "workspace.entries") { pending.current.get(`workspace:${message.path}`)?.(message.entries); pending.current.delete(`workspace:${message.path}`); setMeta((old) => ({ ...old, workspaceBase: message.base, workspace: message.current })); }
    else if (message.type === "workspace.selected") { setMeta((old) => ({ ...old, ...message, workspaceSelected: true })); setWorkspacePicker(false); setActive(null); updateSessionUrl(); setItems([]); setDiff(""); setThreadUsage(null); setCompaction(null); }
    else if (message.type === "system.usage") setResources(message.usage);
    else if (message.type === "account.usage") setAccount(message);
    else if (message.type === "error") { queuedPrompt.current = null; setRunning(false); setItems((old) => [...old, { type: "error", id: `e-${Date.now()}`, message: message.message }]); }
  }, []);
  const { connected, send } = useSocket(onMessage, demo); const sendRef = useRef(send); sendRef.current = send;
  useEffect(() => { if (connected && !demo) { send({ type: "model.list" }); send({ type: "thread.list" }); send({ type: "thread.list", archived: true }); } }, [connected, send]);
  useEffect(() => { if (demo || !connected || meta.codexStatus !== "ready" || !sessionToResume.current) return; const threadId = sessionToResume.current; sessionToResume.current = ""; send({ type: "thread.resume", threadId }); }, [connected, meta.codexStatus, send]);
  useEffect(() => { if (!settings || demo || !connected) return; send({ type: "system.usage" }); send({ type: "account.usage" }); const timer = window.setInterval(() => send({ type: "system.usage" }), 2000); return () => window.clearInterval(timer); }, [settings, connected, send]);
  useEffect(() => { if (compaction?.status !== "completed" || !compaction.at) return; const at = compaction.at; const timer = window.setTimeout(() => setCompaction((current) => current?.at === at ? null : current), 6000); return () => window.clearTimeout(timer); }, [compaction]);
  useEffect(() => { if (fileTarget && meta.workspaceSelected) setFiles(true); }, [fileTarget, meta.workspaceSelected]);

  const create = () => {
    setDiff(""); setItems([]); setActive(null); updateSessionUrl(); setThreadUsage(null); setCompaction(null); setRunning(false);
    if (demo) { const thread = { id: `demo-${Date.now()}`, preview: "New thread", updatedAt: Date.now() / 1000 }; setThreads((old) => [thread, ...old]); setActive(thread); setItems([]); }
    else if (!meta.workspaceSelected) setWorkspacePicker(true);
  };
  const select = (id: string) => demo ? (updateSessionUrl(id), setActive(demoThreads.find((entry) => entry.id === id) || threads.find((entry) => entry.id === id) || null), setItems(id === "demo" ? demoItems : []), setDiff(id === "demo" ? diffFromItems(demoItems) : "")) : send({ type: "thread.resume", threadId: id });
  const mutateThread = (action: "archive" | "unarchive" | "delete", id: string) => {
    if (!demo) return send({ type: `thread.${action}`, threadId: id });
    const source = [...threads, ...archivedThreads]; const thread = source.find((entry) => entry.id === id);
    setThreads((old) => old.filter((entry) => entry.id !== id)); setArchivedThreads((old) => old.filter((entry) => entry.id !== id));
    if (action === "archive" && thread) setArchivedThreads((old) => [thread, ...old]); if (action === "unarchive" && thread) setThreads((old) => [thread, ...old]);
    if (active?.id === id && action !== "unarchive") { setActive(null); setItems([]); setDiff(""); }
  };
  const sendTurn = (text: string, attachments: ComposerAttachment[]) => {
    if (!active && !meta.workspaceSelected) { setWorkspacePicker(true); return false; }
    const localId = crypto.randomUUID(); setItems((old) => [...old, { type: "user_message", id: localId, text, attachments: attachments.map(displayAttachment) }]); setScrollRequest((value) => value + 1);
    if (!active) { queuedPrompt.current = { id: localId, text, attachments }; setRunning(true); send({ type: "thread.create", model, effort, permission }); return true; }
    if (demo) { setRunning(true); const id = `reply-${Date.now()}`; const words = "I’m streaming this response as it arrives from Codex, while reasoning and tool activity remain visible above the final answer.".split(" "); let index = 0; const timer = window.setInterval(() => { index++; setItems((old) => mergeItems(old, [{ type: "assistant_message", id, text: `${words[index - 1]} `, streaming: true }])); if (index >= words.length) { clearInterval(timer); setItems((old) => mergeItems(old, [{ type: "assistant_message", id, text: words.join(" "), streaming: false }])); setThreadUsage({ total: { totalTokens: 1860, inputTokens: 1530, cachedInputTokens: 720, outputTokens: 330, reasoningOutputTokens: 112 }, last: { totalTokens: 1860, inputTokens: 1530, cachedInputTokens: 720, outputTokens: 330, reasoningOutputTokens: 112 }, modelContextWindow: 114688 }); setRunning(false); } }, 75); }
    else send({ type: "turn.send", threadId: active.id, clientUserMessageId: localId, text, attachments, model, effort, permission });
    return true;
  };
  const request = useCallback(<T,>(key: string, message: any) => new Promise<T>((resolve) => {
    pending.current.set(key, resolve);
    if (!demo) return send(message);
    window.setTimeout(() => {
      let value: any;
      if (message.type === "fs.read") { const content = "import { z } from 'zod';\n\nconst userSchema = z.object({\n  email: z.string().email(),\n  name: z.string().min(1),\n});\n\nexport async function createUser(req, res) {\n  const result = userSchema.safeParse(req.body);\n  if (!result.success) {\n    return res.status(400).json({ error: 'Invalid input' });\n  }\n}"; value = { file: { path: message.path, content, size: content.length, previewable: true } }; }
      else if (message.type === "fs.write") value = { file: { path: message.path, content: message.content, size: message.content.length, previewable: true } };
      else if (message.type === "fs.upload") value = { file: { path: [message.directory, message.name].filter(Boolean).join("/"), size: Math.floor((message.data?.length || 0) * 3 / 4) } };
      else if (message.type === "fs.create") value = { file: { path: [message.directory, message.name].filter(Boolean).join("/"), content: "", size: 0, previewable: true } };
      else if (message.type === "fs.delete") value = { file: { path: message.path } };
      else if (message.type === "workspace.list") value = message.path ? [{ name: "project", path: `${message.path}/project`, type: "directory" }] : [{ name: "code", path: "code", type: "directory" }, { name: "projects", path: "projects", type: "directory" }];
      else value = message.path ? [{ name: "users.ts", path: "src/server/users.ts", type: "file" }] : [{ name: "src", path: "src", type: "directory" }, { name: "package.json", path: "package.json", type: "file" }, { name: "README.md", path: "README.md", type: "file" }];
      pending.current.get(key)?.(value); pending.current.delete(key);
    }, 50);
  }), [send]);
  const loadFiles = useCallback(async (path: string) => { const result = await request<any>(`list:${path}`, { type: "fs.list", path }); if (Array.isArray(result)) return result as FileEntry[]; if (result.error) throw new Error(result.error); return result.entries as FileEntry[]; }, [request]);
  const readFile = useCallback(async (path: string) => { const result = await request<any>(`read:${path}`, { type: "fs.read", path }); if (result.error) throw new Error(result.error); return result.file; }, [request]);
  const writeFile = useCallback(async (path: string, content: string) => { const result = await request<any>(`write:${path}`, { type: "fs.write", path, content }); if (result.error) throw new Error(result.error); return result.file; }, [request]);
  const uploadFile = useCallback(async (directory: string, name: string, data: string) => { const requestId = crypto.randomUUID(); const result = await request<any>(`upload:${requestId}`, { type: "fs.upload", requestId, directory, name, data }); if (result.error) throw new Error(result.error); return result.file as { path: string; size: number }; }, [request]);
  const createFile = useCallback(async (directory: string, name: string) => { const requestId = crypto.randomUUID(); const result = await request<any>(`create:${requestId}`, { type: "fs.create", requestId, directory, name }); if (result.error) throw new Error(result.error); return result.file; }, [request]);
  const deleteFile = useCallback(async (path: string) => { const requestId = crypto.randomUUID(); const result = await request<any>(`delete:${requestId}`, { type: "fs.delete", requestId, path }); if (result.error) throw new Error(result.error); return result.file as { path: string }; }, [request]);
  const loadWorkspaces = useCallback((path: string) => request<FileEntry[]>(`workspace:${path}`, { type: "workspace.list", path }), [request]);
  const chooseWorkspace = (path: string) => demo ? (setMeta((old) => ({ ...old, workspace: `${old.workspaceBase}/${path}`.replace(/\/$/, ""), workspaceSelected: true })), setWorkspacePicker(false), setActive(null), setItems([]), setDiff("")) : send({ type: "workspace.select", path });

  const sidebarProps = { threads, archivedThreads, active: active?.id, select, create, archive: (id: string) => mutateThread("archive", id), unarchive: (id: string) => mutateThread("unarchive", id), remove: (id: string) => mutateThread("delete", id), chooseWorkspace: () => setWorkspacePicker(true), workspace: meta.workspaceSelected ? meta.workspace : "" };
  const title = active?.name || active?.preview || "New thread";
  const openWorkspaceFile = (path: string) => { setFileTarget(path); if (meta.workspaceSelected) setFiles(true); else setWorkspacePicker(true); };
  const closeFiles = () => { setFiles(false); setFileTarget(""); const url = new URL(location.href); if (url.searchParams.has("file")) { url.searchParams.delete("file"); history.replaceState(null, "", url); } };
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <div className="desktop-sidebar"><Sidebar {...sidebarProps} onCollapse={() => setSidebarCollapsed(true)} /></div>
    <section className="workspace-shell">
      <header className="workspace-header"><div className="header-leading"><button className="mobile-menu icon-button" aria-label="Open threads" onClick={() => setSidebar(true)}><Menu /></button>{sidebarCollapsed && <button className="desktop-sidebar-open icon-button" aria-label="Open threads" onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen /></button>}<div className="thread-heading"><strong>{title}</strong><span><i className={connected || demo ? "online" : ""} />{running ? "Codex is working" : meta.workspaceSelected ? meta.workspace.split("/").filter(Boolean).pop() : "Choose a workspace"}</span></div></div>
        <div className="header-actions"><span className={`connection ${connected || demo ? "online" : ""}`}><i />{connected || demo ? "Connected" : "Connecting"}</span>{diff && <button className="header-button changes-button" aria-label="Changes" onClick={() => setChanges(true)}><GitCompareArrows /><span>Changes</span></button>}<button className="header-button" aria-label="Files" onClick={() => meta.workspaceSelected ? setFiles(true) : setWorkspacePicker(true)}><FolderOpen /><span>Files</span></button><button className="header-icon-button" aria-label="Settings" onClick={() => setSettings(true)}><Settings2 /></button></div>
      </header>
      <main className={`chat-main ${items.length === 0 ? "is-empty" : ""}`}><Conversation items={items} threadId={active?.id || ""} running={running} scrollRequest={scrollRequest} workspace={meta.workspace} basePath={meta.basePath} openFile={openWorkspaceFile} respond={(item, decision) => { const key = approvalDecisionKey(decision); setItems((old) => old.map((entry) => entry.id === item.id ? { ...item, status: key === "decline" || key === "cancel" ? "denied" : "approved" } : entry)); if (!demo) send({ type: "approval.respond", requestId: item.requestId, decision }); }} /><Composer running={running} disabled={!connected && !demo} send={sendTurn} stop={() => { if (active && turnId) send({ type: "turn.interrupt", threadId: active.id, turnId }); }} models={models} model={model} effort={effort} permission={permission} threadUsage={threadUsage} compaction={compaction} onModel={setModel} onEffort={setEffort} onPermission={setPermission} /></main>
    </section>
    {sidebar && <div className="drawer-layer sidebar-layer" onMouseDown={(event) => event.target === event.currentTarget && setSidebar(false)}><Sidebar {...sidebarProps} onDismiss={() => setSidebar(false)} /></div>}
    {files && <FileDrawer close={closeFiles} load={loadFiles} read={readFile} write={writeFile} upload={uploadFile} create={createFile} remove={deleteFile} initialPath={fileTarget} onSaved={(path, before, after) => setDiff((current) => [current, editDiff(path, before, after)].filter(Boolean).join("\n"))} />}
    {changes && <DiffDrawer diff={diff} close={() => setChanges(false)} />}
    {workspacePicker && <WorkspacePicker close={() => setWorkspacePicker(false)} load={loadWorkspaces} select={chooseWorkspace} current={meta.workspaceSelected ? meta.workspace : ""} base={meta.workspaceBase} />}
    {settings && <SettingsDrawer close={() => setSettings(false)} meta={meta} connected={connected || demo} resources={resources} account={account} threadUsage={threadUsage} active={Boolean(active)} />}
  </div>;
}
