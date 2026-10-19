import type { SessionActivity } from "./session-activity.js";
import { AsyncLocalStorage } from "node:async_hooks";

/** Reads the engine through `/workspace/:id/opencode/*`-shaped semantic paths. */
export type OpenworkEngineReader = {
  activity?(workspaceId: string, sessionId: string): Promise<SessionActivity>;
  get(path: string): Promise<unknown>;
};

/** Per-call host transport. Native plugins never inherit the host credential. */
export type OpenworkReadTransport = OpenworkEngineReader & {
  post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

export const openworkReadTransport = new AsyncLocalStorage<OpenworkReadTransport>();
