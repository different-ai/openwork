import type { SessionActivity } from "./session-activity.js";
import { AsyncLocalStorage } from "node:async_hooks";

/** Per-call host transport. Native plugins never inherit the host credential. */
export const openworkReadTransport = new AsyncLocalStorage<{
  activity?(workspaceId: string, sessionId: string): Promise<SessionActivity>;
  get(path: string): Promise<unknown>;
  post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}>();
