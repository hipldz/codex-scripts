export type UserAttachment = { id?: string; name: string; mime?: string; kind: "image" | "audio" | "text"; data?: string; size?: number };
export type ApprovalDecision = string | Record<string, unknown>;
export type UiItem =
  | { type: "user_message"; id: string; text: string; attachments?: UserAttachment[] }
  | { type: "assistant_message"; id: string; text: string; streaming: boolean }
  | { type: "thinking"; id: string; text: string; status: "running" | "done" }
  | { type: "command"; id: string; command: string; output: string; status: "running" | "done" | "error" }
  | { type: "file_read"; id: string; path: string }
  | { type: "file_change"; id: string; path: string; diff?: string; status?: string }
  | { type: "status"; id: string; title: string; detail?: string; tone?: "info" | "success" | "warning" }
  | { type: "approval"; id: string; requestId: number | string; description: string; status: "pending" | "approved" | "denied"; decisions: ApprovalDecision[]; approvalKind: "command" | "file" }
  | { type: "error"; id: string; message: string };

export type Thread = { id: string; preview: string; name?: string | null; cwd?: string; updatedAt: number; status?: { type?: string } | string };
export type FileEntry = { name: string; path: string; type: "directory" | "file" };

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
};
