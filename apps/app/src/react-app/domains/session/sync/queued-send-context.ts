import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { ModelRef } from "@/app/types";

export type QueuedSendContext = {
  workspaceId: string;
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
