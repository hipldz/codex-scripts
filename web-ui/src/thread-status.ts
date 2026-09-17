import type { Thread } from "./types";

export const threadIsRunning = (thread: Pick<Thread, "status">) => typeof thread.status === "object" && thread.status?.type === "active";
