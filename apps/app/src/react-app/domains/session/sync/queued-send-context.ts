import { openworkAffordanceResultSchema, openworkSessionModelPreflightResultSchema, type OpenworkAffordanceRequest, type OpenworkSessionModel } from "@openwork/types/openwork-affordance";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { ModelRef } from "@/app/types";

export type QueuedSendContext = {
  workspaceId: string;
  rendererWorkspaceId?: string;
  workspaceRoot: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  client: OpenworkServerClient;
  agent: string | null;
  variant: string | null;
  model: ModelRef | null;
  environmentRuntimeKey: string | null;
};

// Context is registered by the mounted surface (enqueueing only happens there)
// and consumed by the global drainer after the surface unmounts.
const queuedSendContexts = new Map<string, QueuedSendContext>();
const listeners = new Set<() => void>();

export function setQueuedSendContext(sessionId: string, context: QueuedSendContext) {
  queuedSendContexts.set(sessionId, context);
  for (const listener of listeners) listener();
}

export async function preflightQueuedSessionModel(context: Pick<QueuedSendContext, "rendererWorkspaceId">, sessionId: string, model: OpenworkSessionModel | null, query: (request: OpenworkAffordanceRequest) => Promise<unknown>) {
  if (!context.rendererWorkspaceId) throw new Error("Renderer workspace identity is unavailable; reopen this session before sending.");
  const checked = openworkAffordanceResultSchema.parse(await query({
    id: "session.model_preflight", args: { workspaceId: context.rendererWorkspaceId, sessionId, model },
  }));
  if (!checked.ok || checked.id !== "session.model_preflight") throw new Error("Selected model is unavailable. Choose another model before sending.");
  const preflight = openworkSessionModelPreflightResultSchema.parse(checked.result);
  if (preflight.workspaceId !== context.rendererWorkspaceId || preflight.sessionId !== sessionId || (model && !preflight.model)) {
    throw new Error("Model preflight identity mismatch.");
  }
  return preflight.model;
}

export function getQueuedSendContext(sessionId: string) {
  return queuedSendContexts.get(sessionId);
}

export function clearQueuedSendContext(sessionId: string) {
  if (!queuedSendContexts.delete(sessionId)) return;
  for (const listener of listeners) listener();
}

export function subscribeQueuedSendContext(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
