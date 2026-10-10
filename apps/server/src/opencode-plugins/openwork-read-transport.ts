import type { SessionActivity } from "./session-activity.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type OpenworkEngine = "v1" | "v2";

/** Reads one engine through v1-shaped `/workspace/:id/opencode/*` paths. */
export type OpenworkEngineReader = {
  engine: OpenworkEngine;
  activity?(workspaceId: string, sessionId: string): Promise<SessionActivity>;
  get(path: string): Promise<unknown>;
};

/** Per-call host transport. Native plugins never inherit the host credential. */
export type OpenworkReadTransport = {
  /** Engine `get` reads. Defaults to v1. */
  engine?: OpenworkEngine;
  activity?(workspaceId: string, sessionId: string): Promise<SessionActivity>;
  get(path: string): Promise<unknown>;
  /** Read-only access to the other engine while both run; sessions created there stay findable. */
  other?: OpenworkEngineReader;
  post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

export const openworkReadTransport = new AsyncLocalStorage<OpenworkReadTransport>();
