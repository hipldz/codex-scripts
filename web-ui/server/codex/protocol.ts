export type JsonRpcId = number | string;
export type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string; data?: any };
};
export type ApprovalDecision = string | Record<string, unknown>;

export type UiItem =
  | { type: "user_message"; id: string; text: string; attachments?: Array<{ id?: string; name: string; mime?: string; kind: "image" | "audio" | "text"; data?: string; size?: number }> }
  | { type: "assistant_message"; id: string; text: string; streaming: boolean }
  | { type: "thinking"; id: string; text: string; status: "running" | "done" }
  | { type: "command"; id: string; command: string; output: string; status: "running" | "done" | "error" }
  | { type: "file_read"; id: string; path: string }
  | { type: "file_change"; id: string; path: string; diff?: string; status?: string }
  | { type: "status"; id: string; title: string; detail?: string; tone?: "info" | "success" | "warning" }
  | { type: "approval"; id: string; requestId: JsonRpcId; description: string; status: "pending" | "approved" | "denied"; decisions: ApprovalDecision[]; approvalKind: "command" | "file" }
  | { type: "error"; id: string; message: string };
