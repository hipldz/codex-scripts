import { Activity, CheckCircle2, ClipboardList, Download, FileImage, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ApprovalDecision, UiItem } from "../types";
import { ApprovalCard } from "./ApprovalCard";
import { CodexLogo } from "./CodexLogo";
import { ToolCard } from "./ToolCard";

type ToolItem = Exclude<UiItem, { type: "user_message" | "assistant_message" | "generated_image" | "approval" | "error" | "status" }>;
type Segment = { type: "item"; item: UiItem } | { type: "activity"; id: string; items: ToolItem[] };

function groupItems(items: UiItem[]): Segment[] {
  const result: Segment[] = [];
  for (const item of items) {
    const isTool = !["user_message", "assistant_message", "generated_image", "approval", "error", "status"].includes(item.type);
    const last = result.at(-1);
    if (isTool && last?.type === "activity") last.items.push(item as ToolItem);
    else if (isTool) result.push({ type: "activity", id: `activity-${item.id}`, items: [item as ToolItem] });
    else result.push({ type: "item", item });
  }
  return result;
}

function StatusLine({ item }: { item: Extract<UiItem, { type: "status" }> }) {
  const Icon = item.title.includes("Plan") ? ClipboardList : item.tone === "success" ? CheckCircle2 : item.tone === "warning" ? TriangleAlert : Info;
  return <section className={`status-line ${item.tone || "info"}`}><Icon /><div><b>{item.title}</b>{item.detail && <pre>{item.detail}</pre>}</div></section>;
}

function ActivityGroup({ items }: { items: ToolItem[] }) {
  const active = items.some((item) => (item.type === "thinking" || item.type === "command") && item.status === "running");
  const count = (type: ToolItem["type"]) => items.filter((item) => item.type === type).length;
  const summary = [[count("file_change"), "file"], [count("file_read"), "file read"], [count("command"), "command"], [count("thinking"), "reasoning step"]].filter(([total]) => total).map(([total, label]) => `${total} ${label}${total === 1 ? "" : "s"}`).join(", ") || `${items.length} activities`;
  return <section className={`activity-group ${active ? "running" : ""}`}>
    <header><span className="activity-icon">{active ? <LoaderCircle /> : <Activity />}</span><div><b>{active ? "Working" : summary}</b><small>{active ? "Codex is reasoning and using tools" : "Turn activity · open any row for details"}</small></div></header>
    <div className="activity-list">{items.map((item) => <ToolCard item={item} key={item.id} />)}</div>
  </section>;
}

const cleanCitations = (text: string) => text.replace(/cite[^]+/g, "");
const normalizeFilePath = (value: string) => { try { return decodeURIComponent(value).replace(/^file:\/\//, "").replaceAll("\\", "/").split(/[?#]/, 1)[0].replace(/:\d+(?::\d+)?$/, ""); } catch { return value.replaceAll("\\", "/").split(/[?#]/, 1)[0].replace(/:\d+(?::\d+)?$/, ""); } };
function workspaceFile(href: string, workspace: string) {
  if (!href || href.startsWith("#") || /^(https?|mailto|tel):/i.test(href)) return null;
  let candidate = normalizeFilePath(href); const root = workspace.replaceAll("\\", "/").replace(/\/$/, "");
  const absolute = candidate.startsWith("/") || /^[a-z]:\//i.test(candidate);
  if (absolute) {
    const compareCandidate = /^[a-z]:/i.test(candidate) ? candidate.toLowerCase() : candidate; const compareRoot = /^[a-z]:/i.test(root) ? root.toLowerCase() : root;
    if (!compareRoot || !compareCandidate.startsWith(`${compareRoot}/`)) return { unavailable: true as const, path: "" };
    candidate = candidate.slice(root.length + 1);
  } else {
    candidate = candidate.replace(/^\.\//, ""); const rootName = root.split("/").pop();
    if (rootName && candidate.startsWith(`${rootName}/`)) candidate = candidate.slice(rootName.length + 1);
  }
  const parts = candidate.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return { unavailable: true as const, path: "" };
  return { unavailable: false as const, path: parts.join("/") };
}

export function Conversation({ items, threadId, running, scrollRequest, workspace, basePath, hasEarlier, loadingEarlier, loadEarlier, openFile, respond }: { items: UiItem[]; threadId: string; running: boolean; scrollRequest: number; workspace: string; basePath: string; hasEarlier: boolean; loadingEarlier: boolean; loadEarlier: () => void; openFile: (path: string) => void; respond: (item: Extract<UiItem, { type: "approval" }>, decision: ApprovalDecision) => void }) {
  const scroll = useRef<HTMLDivElement>(null); const newestUser = useRef<HTMLElement>(null); const lastScrollRequest = useRef(0); const prependHeight = useRef(0); const [following, setFollowing] = useState(true); const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const segments = useMemo(() => groupItems(items), [items]);
  const prefix = basePath === "/" ? "" : basePath;
  const resolvedImage = (src: string) => {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    const normalized = normalizeFilePath(src);
    if (normalized.startsWith("/") && normalized.includes("/generated_images/")) return `${prefix}/api/generated-images/raw?path=${encodeURIComponent(normalized)}`;
    const local = workspaceFile(src, workspace);
    return local && !local.unavailable ? `${prefix}/api/files/raw?path=${encodeURIComponent(local.path)}` : src;
  };
  useLayoutEffect(() => { setFollowing(true); setPreviewImage(null); const element = scroll.current; if (element) element.scrollTop = element.scrollHeight; }, [threadId]);
  useLayoutEffect(() => { const element = scroll.current; if (!element || !prependHeight.current) return; element.scrollTop += element.scrollHeight - prependHeight.current; prependHeight.current = 0; }, [items]);
  useEffect(() => { if (following) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [items, following]);
  useEffect(() => { if (scrollRequest === lastScrollRequest.current) return; lastScrollRequest.current = scrollRequest; newestUser.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [items, scrollRequest]);
  return <div className="conversation" ref={scroll} onScroll={() => { const element = scroll.current; if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 100); }}>
    <div className="conversation-inner">{hasEarlier && <button type="button" className="load-earlier" disabled={loadingEarlier} onClick={() => { prependHeight.current = scroll.current?.scrollHeight || 0; loadEarlier(); }}>{loadingEarlier && <LoaderCircle />}<span>{loadingEarlier ? "Loading…" : "Show earlier messages"}</span></button>}{items.length === 0 && <div className="empty-chat"><span className="empty-logo"><CodexLogo /></span><h1>What are we coding next?</h1><p>Describe a task, ask a question, or explore this workspace with Codex.</p></div>}
    {segments.map((segment) => segment.type === "activity" ? <ActivityGroup items={segment.items} key={segment.id} /> : segment.item.type === "user_message" ? <article className="message user" key={segment.item.id} ref={(element) => { if (element && segment.item.id === items.at(-1)?.id) newestUser.current = element; }}><div className="user-bubble">{segment.item.attachments?.length ? <div className="user-attachments">{segment.item.attachments.map((attachment, index) => { const prefix = basePath === "/" ? "" : basePath; const download = attachment.id && threadId ? `${prefix}/attachments/${encodeURIComponent(threadId)}/${encodeURIComponent(segment.item.id)}/${encodeURIComponent(attachment.id)}` : ""; return attachment.kind === "image" && attachment.data ? <img className="user-attachment-image" src={attachment.data} alt={attachment.name} key={`${attachment.name}-${index}`} /> : <div className="user-attachment-file" key={`${attachment.name}-${index}`}><FileImage /><span>{attachment.name}</span>{download && <a className="user-attachment-download" href={download} download={attachment.name} aria-label={`Download ${attachment.name}`}><Download /></a>}</div>; })}</div> : null}{segment.item.text && <p>{segment.item.text}</p>}</div></article>
      : segment.item.type === "assistant_message" ? <article className={`message assistant ${segment.item.streaming ? "is-streaming" : ""}`} key={segment.item.id}><div className="avatar codex-avatar"><CodexLogo /></div><div className="assistant-body"><ReactMarkdown components={{ a: ({ href = "", children, ...props }) => { const local = workspaceFile(href, workspace); if (!local) return <a href={href} {...props}>{children}</a>; if (local.unavailable) return <span className="unavailable-file-link" title="This file is outside the selected workspace">{children}</span>; if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(local.path)) { const image = `${prefix}/api/files/raw?path=${encodeURIComponent(local.path)}`; return <span className="assistant-image-link"><button type="button" className="conversation-image" onClick={() => setPreviewImage({ src: image, alt: local.path.split("/").pop() || "Image" })}><img src={image} alt={local.path.split("/").pop()} loading="lazy" /></button><a href={`${prefix}/api/files/download?path=${encodeURIComponent(local.path)}`} download>{children}</a></span>; } return <a className="workspace-file-link" href={`${prefix}/?file=${encodeURIComponent(local.path)}`} onClick={(event) => { event.preventDefault(); openFile(local.path); }}>{children}</a>; }, img: ({ src = "", alt = "" }) => { const image = resolvedImage(src); return <button type="button" className="conversation-image" onClick={() => setPreviewImage({ src: image, alt })}><img src={image} alt={alt} loading="lazy" /></button>; } }}>{cleanCitations(segment.item.text)}</ReactMarkdown>{segment.item.streaming && <span className="stream-cursor" />}</div></article>
      : segment.item.type === "generated_image" ? <article className="message assistant generated-image" key={segment.item.id}><div className="avatar codex-avatar"><CodexLogo /></div><button type="button" className="conversation-image" onClick={() => { const image = segment.item as Extract<UiItem, { type: "generated_image" }>; setPreviewImage({ src: resolvedImage(image.src), alt: image.alt }); }}><img src={resolvedImage(segment.item.src)} alt={segment.item.alt} loading="lazy" /></button></article>
      : segment.item.type === "approval" ? <ApprovalCard key={segment.item.id} item={segment.item} respond={(decision) => respond(segment.item as Extract<UiItem, { type: "approval" }>, decision)} />
      : segment.item.type === "status" ? <StatusLine key={segment.item.id} item={segment.item} />
      : segment.item.type === "error" ? <div className="error-card" key={segment.item.id}>{segment.item.message}</div> : null)}
    {running && !items.some((item) => (item.type === "thinking" && item.status === "running") || (item.type === "assistant_message" && item.streaming)) && <div className="thinking-live"><LoaderCircle /><div><b>Starting</b><span>Codex is preparing the turn</span></div></div>}
    </div>{previewImage && <div className="image-lightbox" role="dialog" aria-label={previewImage.alt || "Image preview"} onMouseDown={(event) => event.target === event.currentTarget && setPreviewImage(null)}><button type="button" aria-label="Close image preview" onClick={() => setPreviewImage(null)}>×</button><img src={previewImage.src} alt={previewImage.alt} /></div>}
  </div>;
}
