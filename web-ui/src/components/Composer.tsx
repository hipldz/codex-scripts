import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, FileText, Paperclip, ShieldCheck, Square, X } from "lucide-react";
import type { ModelOption } from "../types";
import type { CompactionStatus, ThreadUsage } from "./SettingsDrawer";
import { ModelPicker } from "./ModelPicker";

export type ComposerAttachment = { id: string; name: string; mime: string; kind: "image" | "text"; data: string; size: number };
export type PermissionPreset = "ask" | "full" | "read-only";
const textTypes = new Set(["text/plain", "text/markdown", "application/json", "application/xml", "application/javascript", "application/typescript"]);
const asDataUrl = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });

const compactNumber = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const permissionLabels: Record<PermissionPreset, string> = { ask: "Ask when needed", full: "Full access", "read-only": "Read-only" };

function PermissionPicker({ permission, disabled, onPermission }: { permission: PermissionPreset; disabled: boolean; onPermission: (permission: PermissionPreset) => void }) {
  const [open, setOpen] = useState(false); const root = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, []);
  return <div className="permission-control" ref={root}>
    <button className="permission-trigger" type="button" disabled={disabled} aria-label="Session permission" aria-expanded={open} onClick={() => setOpen((value) => !value)}><ShieldCheck /><span>{permissionLabels[permission]}</span><ChevronDown /></button>
    {open && <div className="permission-menu">{(Object.keys(permissionLabels) as PermissionPreset[]).map((value) => <button type="button" className={value === permission ? "selected" : ""} key={value} onClick={() => { onPermission(value); setOpen(false); }}><span><b>{permissionLabels[value]}</b><small>{value === "full" ? "No sandbox or approval prompts" : value === "ask" ? "Workspace access with approvals" : "Inspect files without changes"}</small></span>{value === permission && <Check />}</button>)}</div>}
  </div>;
}

export function Composer({ running, disabled, send, stop, models, model, effort, permission, threadUsage, compaction, onModel, onEffort, onPermission }: { running: boolean; disabled: boolean; send: (text: string, attachments: ComposerAttachment[]) => boolean; stop: () => void; models: ModelOption[]; model: string; effort: string; permission: PermissionPreset; threadUsage: ThreadUsage | null; compaction: CompactionStatus; onModel: (model: string) => void; onEffort: (effort: string) => void; onPermission: (permission: PermissionPreset) => void }) {
  const [text, setText] = useState(""); const [attachments, setAttachments] = useState<ComposerAttachment[]>([]); const [attachmentError, setAttachmentError] = useState(""); const [preview, setPreview] = useState<ComposerAttachment | null>(null);
  const area = useRef<HTMLTextAreaElement>(null); const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (area.current) { area.current.style.height = "0"; area.current.style.height = `${Math.min(area.current.scrollHeight, 160)}px`; } }, [text]);
  useEffect(() => { if (!preview) return; const close = (event: KeyboardEvent) => event.key === "Escape" && setPreview(null); addEventListener("keydown", close); return () => removeEventListener("keydown", close); }, [preview]);
  const submit = () => { if ((!text.trim() && !attachments.length) || running) return; if (send(text.trim(), attachments)) { setText(""); setAttachments([]); setAttachmentError(""); } };
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return; setAttachmentError("");
    const next: ComposerAttachment[] = [];
    for (const file of Array.from(files).slice(0, Math.max(0, 4 - attachments.length))) {
      const image = file.type.startsWith("image/"); const textFile = textTypes.has(file.type) || /\.(txt|md|json|ya?ml|xml|csv|tsx?|jsx?|py|rs|go|java|c|cc|cpp|h|hpp|css|html|sh|toml)$/i.test(file.name);
      if (!image && !textFile) { setAttachmentError(`Unsupported attachment: ${file.name}`); continue; }
      if (file.size > (image ? 10 : 1) * 1024 * 1024) { setAttachmentError(`${file.name} is too large`); continue; }
      next.push({ id: crypto.randomUUID(), name: file.name, mime: file.type || (image ? "image/png" : "text/plain"), kind: image ? "image" : "text", data: await asDataUrl(file), size: file.size });
    }
    setAttachments((old) => [...old, ...next].slice(0, 4)); if (input.current) input.current.value = "";
  };
  const paste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault(); void addFiles(files);
  };
  const contextPercent = threadUsage?.modelContextWindow ? Math.max(0, Math.min(100, threadUsage.last.inputTokens / threadUsage.modelContextWindow * 100)) : null;
  return <><div className="composer-wrap"><div className="composer">
    {attachments.length > 0 && <div className="attachment-list">{attachments.map((attachment) => <div className="attachment-chip" key={attachment.id}>{attachment.kind === "image" ? <button type="button" className="attachment-preview-button" aria-label={`View ${attachment.name}`} onClick={() => setPreview(attachment)}><img src={attachment.data} alt="" /></button> : <span><FileText /></span>}<div><b>{attachment.name}</b><small>{attachment.kind === "image" ? "Image" : "Text file"} · {Math.max(1, Math.round(attachment.size / 1024))} KB</small></div><button type="button" className="attachment-remove" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((old) => old.filter((item) => item.id !== attachment.id))}><X /></button></div>)}</div>}
    {attachmentError && <div className="attachment-error">{attachmentError}</div>}
    <textarea ref={area} value={text} disabled={disabled} rows={1} placeholder={disabled ? "Connect to Codex to start…" : "Ask Codex to work on your code"} onPaste={paste} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && matchMedia("(min-width: 701px)").matches) { event.preventDefault(); submit(); } }} />
    <div className="composer-toolbar"><div className="composer-tools"><input ref={input} className="attachment-input" type="file" multiple accept="image/*,.txt,.md,.json,.yaml,.yml,.xml,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cc,.cpp,.h,.hpp,.css,.html,.sh,.toml" onChange={(event) => addFiles(event.target.files)} /><button className="attach-button" type="button" aria-label="Add attachment" onClick={() => input.current?.click()}><Paperclip /></button><ModelPicker models={models} model={model} effort={effort} onModel={onModel} onEffort={onEffort} /><PermissionPicker permission={permission} disabled={running} onPermission={onPermission} />{effort && <span className="effort-chip">{effort}</span>}</div>
      <div className="composer-actions">{(contextPercent != null || compaction) && <div className={`context-indicator ${compaction?.status || ""}`} tabIndex={0} aria-label="Context window usage"><span style={{ "--context-used": `${contextPercent || 0}%` } as React.CSSProperties}><i /></span><div className="context-tooltip"><b>{compaction?.status === "running" ? "Compacting context…" : "Context window"}</b>{contextPercent != null && threadUsage?.modelContextWindow ? <><strong>{contextPercent.toFixed(0)}% used ({(100 - contextPercent).toFixed(0)}% left)</strong><em>{compactNumber(threadUsage.last.inputTokens)} / {compactNumber(threadUsage.modelContextWindow)} tokens used</em></> : <em>Usage appears after the next response</em>}{compaction?.status === "completed" && <small>Context compacted{compaction.at ? ` · ${new Date(compaction.at).toLocaleTimeString()}` : ""}</small>}</div></div>}<button className={`send ${running ? "stop" : ""}`} aria-label={running ? "Stop" : "Send"} onClick={running ? stop : submit}>{running ? <Square /> : <ArrowUp />}</button></div>
    </div>
  </div><div className="composer-hint">Codex can make mistakes. Review changes before committing.</div></div>{preview && <div className="image-lightbox" role="dialog" aria-label={preview.name} onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}><button type="button" aria-label="Close image preview" onClick={() => setPreview(null)}><X /></button><img src={preview.data} alt={preview.name} /></div>}</>;
}
