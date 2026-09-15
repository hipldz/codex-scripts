import { useCallback, useEffect, useRef, useState } from "react";

const apiBase = () => `${location.pathname.replace(/\/?$/, "/")}api`;

export function useApiTransport(onMessage: (message: any) => void, disabled = false) {
  const handler = useRef(onMessage); handler.current = onMessage;
  const cursor = useRef(0); const busy = useRef(false); const [connected, setConnected] = useState(disabled);
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    if (disabled) return; let live = true; let timer = 0; let polling = false; const base = apiBase();
    const schedulePoll = (delay: number) => { window.clearTimeout(timer); if (live) timer = window.setTimeout(poll, delay); };
    const bootstrap = async () => {
      let delay = 400;
      try {
        const response = await fetch(`${base}/bootstrap`, { cache: "no-store" }); const data = await response.json(); setConnected(true);
        if (data.meta) handler.current({ type: "status", ...data.meta, runtime: data.runtime });
        handler.current({ type: "bootstrap.stage", stage: data.stage || "starting", error: data.error || data.runtime?.lastError || "" });
        if (data.ready) {
          cursor.current = data.eventCursor || cursor.current;
          handler.current({ type: "models", models: data.models || [] });
          handler.current({ type: "threads", threads: data.threads || [], nextCursor: data.nextCursor || null, archived: false });
          handler.current({ type: "bootstrap.ready" });
          void poll(); return;
        }
        if (data.stage === "error") { delay = 2_500; handler.current({ type: "bootstrap.error", message: data.error || data.runtime?.lastError || "Codex failed to start" }); }
      } catch { setConnected(false); }
      if (live) timer = window.setTimeout(bootstrap, delay);
    };
    const poll = async () => {
      if (polling || !live) return;
      polling = true;
      try {
        const response = await fetch(`${base}/events?cursor=${cursor.current}`, { cache: "no-store" }); if (!response.ok) throw new Error("Event poll failed");
        const data = await response.json(); cursor.current = data.cursor || cursor.current;
        if (data.reset) handler.current({ type: "events.reset" });
        for (const event of data.events || []) { const message = event.message; if (message.type === "event" && typeof message.running === "boolean") busy.current = message.running; handler.current(message); }
        setConnected(true);
      } catch { setConnected(false); }
      polling = false;
      schedulePoll(document.hidden ? 15_000 : busy.current ? 650 : 2_500);
    };
    wake.current = () => schedulePoll(0);
    void bootstrap(); return () => { live = false; wake.current = () => {}; window.clearTimeout(timer); };
  }, [disabled]);

  const send = useCallback((message: any) => {
    if (disabled) return;
    void fetch(`${apiBase()}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message) })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Request failed"); for (const item of data.messages || []) { if (item.type === "turn.accepted") busy.current = true; handler.current(item); } if (["turn.send", "turn.interrupt", "approval.respond", "runtime.start", "runtime.restart"].includes(message.type)) wake.current(); })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        const type = message.type === "fs.list" ? "fs.entries" : message.type === "fs.read" ? "fs.file" : message.type === "fs.write" ? "fs.saved" : message.type === "fs.upload" ? "fs.uploaded" : message.type === "fs.create" ? "fs.created" : message.type === "fs.delete" ? "fs.deleted" : "error";
        handler.current({ type, path: message.path, requestId: message.requestId, error: detail, message: detail });
      });
  }, [disabled]);
  return { connected, send };
}
