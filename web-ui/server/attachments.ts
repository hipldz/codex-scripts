import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

export type AttachmentKind = "image" | "audio" | "text" | "file";

export type IncomingAttachment = {
  id?: unknown;
  name?: unknown;
  mime?: unknown;
  kind?: unknown;
  data?: unknown;
};

export type AttachmentSummary = {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  data?: string;
};

export type PreparedAttachment = AttachmentSummary & {
  bytes: Buffer;
  dataUrl: string;
  text?: string;
};

export type PersistedMessage = {
  messageId: string;
  prompt: string;
  attachments: AttachmentSummary[];
  prepared: PreparedAttachment[];
};

type ManifestAttachment = Omit<AttachmentSummary, "data"> & {
  relativePath: string;
  sha256: string;
};

type AttachmentManifest = {
  version: 1;
  threadId: string;
  messageId: string;
  turnId?: string;
  prompt: string;
  createdAt: number;
  attachments: ManifestAttachment[];
};

type DownloadableAttachment = {
  path: string;
  name: string;
  mime: string;
  size: number;
};

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{1,160}$/;

const asToken = (value: unknown, fallback: string = crypto.randomUUID()): string => {
  const candidate = typeof value === "string" ? value : "";
  return TOKEN.test(candidate) ? candidate : fallback;
};

const safeName = (value: unknown) => {
  const original = typeof value === "string" ? value : "";
  const leaf = original.replaceAll("\\", "/").split("/").pop() || "attachment";
  const cleaned = leaf.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
  return cleaned.slice(0, 180);
};

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

function decodeData(value: unknown) {
  if (typeof value !== "string") throw new Error("Attachment data is missing");
  const match = value.match(/^data:([^;,]+)?((?:;[^,]*)?),([\s\S]*)$/i);
  if (!match) return { bytes: Buffer.from(value, "utf8"), mime: "" };

  const metadata = match[2] || "";
  const encoded = match[3];
  if (/;base64(?:;|$)/i.test(metadata)) {
    const compact = encoded.replace(/\s/g, "");
    if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error("Invalid base64 attachment data");
    return { bytes: Buffer.from(compact, "base64"), mime: match[1] || "" };
  }
  try {
    return { bytes: Buffer.from(decodeURIComponent(encoded), "utf8"), mime: match[1] || "" };
  } catch {
    throw new Error("Invalid attachment data");
  }
}

function preparedAttachment(input: IncomingAttachment): PreparedAttachment {
  const kind = input.kind === "image" || input.kind === "audio" || input.kind === "text" || input.kind === "file" ? input.kind : null;
  if (!kind) throw new Error("Unsupported attachment type");
  const decoded = decodeData(input.data);
  const providedMime = typeof input.mime === "string" ? input.mime.trim().toLowerCase() : "";
  const mime = providedMime || decoded.mime || (kind === "image" ? "image/png" : kind === "audio" ? "audio/mpeg" : kind === "text" ? "text/plain" : "application/octet-stream");
  if (decoded.bytes.length > MAX_ATTACHMENT_SIZE) throw new Error(`${safeName(input.name)} is too large (maximum 10 MB)`);
  if (kind === "image" && !mime.startsWith("image/")) throw new Error(`${safeName(input.name)} is not a supported image`);
  if (kind === "audio" && !mime.startsWith("audio/")) throw new Error(`${safeName(input.name)} is not a supported audio file`);
  const name = safeName(input.name);
  const id = asToken(input.id);
  const summary: AttachmentSummary = { id, name, mime, kind, size: decoded.bytes.length };
  return { ...summary, bytes: decoded.bytes, dataUrl: dataUrl(mime, decoded.bytes), text: kind === "text" ? decoded.bytes.toString("utf8") : undefined };
}

export class AttachmentStore {
  private readonly root: string;

  constructor() {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    this.root = path.join(codexHome, "attachments", "codex-web");
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }

  private inside(candidate: string) {
    const relative = path.relative(this.root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private messageDirectory(threadId: unknown, messageId: unknown) {
    const thread = asToken(threadId, "");
    const message = asToken(messageId, "");
    if (!thread || !message) return null;
    return path.join(this.root, thread, message);
  }

  private async readManifest(file: string): Promise<AttachmentManifest | null> {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as AttachmentManifest;
      if (value?.version !== 1 || !Array.isArray(value.attachments) || typeof value.messageId !== "string") return null;
      return value;
    } catch {
      return null;
    }
  }

  private async findManifest(threadId: string, messageId: string, turnId?: string, attachmentId?: string) {
    const direct = this.messageDirectory(threadId, messageId);
    if (direct) {
      const manifest = await this.readManifest(path.join(direct, "manifest.json"));
      if (manifest && (!attachmentId || manifest.attachments.some((item) => item.id === attachmentId))) return manifest;
    }
    if (!turnId && !attachmentId) return null;
    const threadToken = asToken(threadId, "");
    const threadDirectory = threadToken ? path.join(this.root, threadToken) : "";
    if (!threadDirectory) return null;
    let entries: Array<import("node:fs").Dirent> = [];
    try { entries = await fs.readdir(threadDirectory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !TOKEN.test(entry.name)) continue;
      const manifest = await this.readManifest(path.join(threadDirectory, entry.name, "manifest.json"));
      if (manifest && ((turnId && manifest.turnId === turnId) || (attachmentId && manifest.attachments.some((item) => item.id === attachmentId)))) return manifest;
    }
    return null;
  }

  async save(threadId: string, messageId: string, prompt: string, inputs: IncomingAttachment[]): Promise<PersistedMessage> {
    await this.init();
    const prepared = inputs.map(preparedAttachment);
    if (prepared.reduce((total, attachment) => total + attachment.size, 0) > MAX_TOTAL_ATTACHMENT_SIZE) throw new Error("Attachments exceed the 10 MB total limit");
    const directory = this.messageDirectory(threadId, messageId);
    if (!directory) throw new Error("Invalid attachment message ID");
    try {
      await fs.mkdir(directory, { recursive: true });
      const threadToken = asToken(threadId, "thread");
      const messageToken = asToken(messageId, "message");
      const manifestAttachments: ManifestAttachment[] = [];
      for (const [index, attachment] of prepared.entries()) {
        const fileName = `${index}-${attachment.name}`;
        const file = path.resolve(directory, fileName);
        if (!this.inside(file)) throw new Error("Invalid attachment path");
        await fs.writeFile(file, attachment.bytes);
        manifestAttachments.push({
          id: attachment.id,
          name: attachment.name,
          mime: attachment.mime,
          kind: attachment.kind,
          size: attachment.size,
          relativePath: path.posix.join(threadToken, messageToken, fileName),
          sha256: crypto.createHash("sha256").update(attachment.bytes).digest("hex"),
        });
      }
      const manifest: AttachmentManifest = { version: 1, threadId, messageId, prompt, createdAt: Date.now(), attachments: manifestAttachments };
      const temporary = path.join(directory, `.manifest-${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
      await fs.rename(temporary, path.join(directory, "manifest.json"));
      return { messageId, prompt, attachments: prepared.map(({ bytes: _bytes, dataUrl: _dataUrl, text: _text, ...summary }) => summary), prepared };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async setTurnId(threadId: string, messageId: string, turnId: unknown) {
    const directory = this.messageDirectory(threadId, messageId);
    const value = typeof turnId === "string" && turnId ? turnId : "";
    if (!directory || !value) return;
    const file = path.join(directory, "manifest.json");
    const manifest = await this.readManifest(file);
    if (!manifest) return;
    manifest.turnId = value;
    await fs.writeFile(file, JSON.stringify(manifest, null, 2), "utf8");
  }

  async cloneMessage(sourceThreadId: string, targetThreadId: string, messageId: string) {
    const source = this.messageDirectory(sourceThreadId, messageId); const target = this.messageDirectory(targetThreadId, messageId);
    const targetThread = asToken(targetThreadId, ""); const targetMessage = asToken(messageId, "");
    if (!source || !target || !targetThread || !targetMessage || source === target) return;
    try { if (!(await fs.stat(source)).isDirectory()) return; } catch { return; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: true });
    const manifestFile = path.join(target, "manifest.json"); const manifest = await this.readManifest(manifestFile); if (!manifest) return;
    manifest.threadId = targetThread;
    manifest.attachments = manifest.attachments.map((attachment) => ({ ...attachment, relativePath: path.posix.join(targetThread, targetMessage, path.posix.basename(attachment.relativePath)) }));
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  }

  async load(threadId: string, messageId: string, turnId?: string) {
    await this.init();
    const manifest = await this.findManifest(threadId, messageId, turnId);
    if (!manifest) return null;
    const attachments: AttachmentSummary[] = [];
    for (const attachment of manifest.attachments) {
      const file = path.resolve(this.root, attachment.relativePath);
      if (!this.inside(file)) continue;
      try { if (!(await fs.stat(file)).isFile()) continue; } catch { continue; }
      attachments.push({ id: attachment.id, name: attachment.name, mime: attachment.mime, kind: attachment.kind, size: attachment.size });
    }
    return { messageId: manifest.messageId, prompt: manifest.prompt, attachments };
  }

  async resolveDownload(threadId: string, messageId: string, attachmentId: string): Promise<DownloadableAttachment | null> {
    await this.init();
    if (!TOKEN.test(attachmentId)) return null;
    const manifest = await this.findManifest(threadId, messageId, undefined, attachmentId);
    const attachment = manifest?.attachments.find((item) => item.id === attachmentId);
    if (!manifest || !attachment) return null;
    const file = path.resolve(this.root, attachment.relativePath);
    if (!this.inside(file)) return null;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      return { path: file, name: attachment.name, mime: attachment.mime, size: stat.size };
    } catch {
      return null;
    }
  }

  async removeMessage(threadId: string, messageId: string) {
    const directory = this.messageDirectory(threadId, messageId);
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }

  async removeThread(threadId: string) {
    const token = asToken(threadId, "");
    if (token) await fs.rm(path.join(this.root, token), { recursive: true, force: true });
  }
}
