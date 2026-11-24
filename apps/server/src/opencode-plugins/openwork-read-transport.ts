import type { SessionActivity } from "./session-activity.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type OpenworkEngine = "v1" | "v2";

export type OpenworkEngineReader = {
  engine: OpenworkEngine;
  activity?(workspaceId: string, sessionId: string): Promise<SessionActivity>;
  get(path: string): Promise<unknown>;
};

export type OpenworkReadTransport = {
  engine?: OpenworkEngine;
  activity?(workspaceId: string, sessionId: string): Promise<SessionActivity>;
  get(path: string): Promise<unknown>;
  other?: OpenworkEngineReader;
  post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  send?(method: "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<unknown>;
};

export const openworkReadTransport = new AsyncLocalStorage<OpenworkReadTransport>();
