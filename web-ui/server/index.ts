import http from "node:http";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config, route } from "./config.js";
import { WorkspaceFs } from "./filesystem.js";
import { CodexClient } from "./codex/client.js";
import { AttachmentStore } from "./attachments.js";
import { wireSockets } from "./websocket.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workspaceFs = new WorkspaceFs(config.workspace, config.workspaceBase, config.workspaceExplicit);
await workspaceFs.init();
const attachmentStore = new AttachmentStore();
await attachmentStore.init();
const codex = new CodexClient(workspaceFs.path);
const vite = config.dev ? await (await import("vite")).createServer({ root, server: { middlewareMode: true }, appType: "spa" }) : null;
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const expectedAuthorization = config.auth ? `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`, "utf8").toString("base64")}` : null;
const authorized = (req: http.IncomingMessage) => {
  if (!expectedAuthorization) return true;
  const received = Buffer.from(req.headers.authorization || "", "utf8"); const expected = Buffer.from(expectedAuthorization, "utf8");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
};
const requireAuthorization = (res: http.ServerResponse) => {
  res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "WWW-Authenticate": 'Basic realm="Codex Web", charset="UTF-8"' });
  res.end("Authentication required");
};

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return requireAuthorization(res);
  const url = new URL(req.url || "/", "http://localhost");
  const prefix = config.basePath === "/" ? "" : config.basePath;
  if (prefix && url.pathname === prefix) { res.writeHead(308, { Location: `${prefix}/${url.search}` }); return res.end(); }
  if (prefix && !url.pathname.startsWith(`${prefix}/`)) { res.writeHead(404); return res.end("Not found"); }
  const localPath = url.pathname.slice(prefix.length) || "/";
  const attachmentMatch = localPath.match(/^\/attachments\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (attachmentMatch) {
    let parts: string[];
    try { parts = attachmentMatch.slice(1).map((part) => decodeURIComponent(part)); } catch { res.writeHead(404); return res.end("Not found"); }
    let download;
    try { download = await attachmentStore.resolveDownload(parts[0], parts[1], parts[2]); } catch { download = null; }
    if (!download) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": download.mime, "Content-Length": download.size, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    createReadStream(download.path).on("error", () => { if (!res.headersSent) res.writeHead(404); res.end(); }).pipe(res);
    return;
  }
  if (vite) {
    req.url = `${localPath}${url.search}`;
    return vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
  }
  try {
    const relative = localPath === "/" ? "index.html" : localPath.replace(/^\//, "");
    const target = path.resolve(root, "dist", relative);
    if (!target.startsWith(path.resolve(root, "dist"))) throw new Error("Invalid asset path");
    const data = await fs.readFile(target);
    res.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream", "Cache-Control": relative === "index.html" ? "no-cache" : "public, max-age=31536000, immutable" }); res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Not found");
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Codex Web", charset="UTF-8"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return socket.destroy();
  }
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname !== route("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wireSockets(wss, codex, workspaceFs, attachmentStore, () => ({ workspace: workspaceFs.path, workspaceBase: workspaceFs.basePath, workspaceSelected: workspaceFs.isSelected, basePath: config.basePath, codexVersion: codex.userAgent }));
server.listen(config.port, config.host, async () => {
  console.log(`Codex Web: http://${config.host}:${config.port}${route()}`);
  console.log(`Workspace: ${workspaceFs.path}`);
  console.log(`HTTP Basic Auth: ${config.auth ? "enabled" : "disabled"}`);
  try { await codex.start(); } catch (error) { console.error("Codex app-server failed:", error); }
});
process.on("SIGTERM", () => { codex.stop(); server.close(); });
process.on("SIGINT", () => { codex.stop(); server.close(); });
