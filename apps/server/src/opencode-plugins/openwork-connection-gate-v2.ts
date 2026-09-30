import {
  connectionResultRecord,
  connectionTargetFromResult,
  isMemberConnectionDecision,
  type HostConnectionDecision,
} from "@openwork/types/connection-action-app";

export type ConnectionGateEndpoint = { url: string; token: string };
export type ConnectionToolEvent = {
  readonly tool: string;
  readonly sessionID?: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
} & (
  | { readonly status: "completed"; result: { output?: unknown; content?: unknown[]; metadata?: Record<string, unknown> } }
  | { readonly status: "error"; error: unknown }
);

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "";
}

/** Only a requested operation or explicit connect search may interrupt a turn. */
function connectionFor(event: ConnectionToolEvent) {
  if (!/^(?:openwork|openwork-cloud)_(?:search_capabilities|execute_capability|connection_action)$/.test(event.tool)) return null;
  const result = connectionResultRecord(event.status === "completed" ? event.result.output : errorText(event.error));
  if (event.tool.endsWith("_search_capabilities")) {
    const input = connectionResultRecord(event.input);
    if (input?.intent !== "connect" || !result?.connectionAction) return null;
  }
  const target = connectionTargetFromResult(result);
  return target?.memberOAuth && isMemberConnectionDecision(target.connection) ? target.connection : null;
}

/**
 * Hold a blocked result before either Code Mode or the model can receive it.
 * The host owns support negotiation and the native form; this hook never
 * issues a model question, edits assistant text, or retries an operation.
 */
export async function waitForConnectionDecision(
  event: ConnectionToolEvent,
  endpoint: ConnectionGateEndpoint | undefined,
  signal: AbortSignal,
): Promise<HostConnectionDecision | null> {
  if (!endpoint || !event.sessionID) return null;
  const connection = connectionFor(event);
  if (!connection) return null;
  const response = await fetch(endpoint.url, {
    method: "POST", redirect: "error", signal,
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      sessionID: event.sessionID, messageID: event.messageID, id: event.id,
      tool: event.tool, connection,
    }),
  });
  if (!response.ok) throw new Error("The connection decision could not be delivered. Try the task again.");
  const result = connectionResultRecord(await response.json());
  if (result?.outcome === "unsupported") return null;
  if (result?.outcome !== "connected" && result?.outcome !== "skipped") {
    throw new Error("The connection decision was cancelled.");
  }
  const decision: HostConnectionDecision = { connection, outcome: result.outcome };
  const continuation = result.outcome === "connected"
    ? { outcome: "connected", continuation: "review_remaining_work", repeatCompletedWrites: false }
    : { outcome: "skipped", continuation: "without_connection", alternativeAuthorization: false };
  if (event.status === "completed") {
    const original = connectionResultRecord(event.result.output) ?? {};
    event.result.output = { ...original, connectionDecision: continuation };
    event.result.content = event.result.content?.length
      ? [...event.result.content, { type: "text", text: JSON.stringify({ connectionDecision: continuation }) }]
      : [{ type: "text", text: JSON.stringify(event.result.output) }];
    event.result.metadata = { ...event.result.metadata, openworkConnectionDecision: decision };
  } else {
    // Remain a failed tool call. Authentication does not prove the requested
    // operation ran, and replaying it could duplicate a write at the provider.
    const original = connectionResultRecord(errorText(event.error)) ?? {};
    // The pinned engine yields this Tool.Error after the hook. Preserve its
    // prototype/yield implementation rather than replacing it with an Error.
    if (typeof event.error === "object" && event.error !== null && "message" in event.error) {
      event.error.message = JSON.stringify({ ...original, connectionDecision: continuation, openworkConnectionDecision: decision });
    }
  }
  return decision;
}
