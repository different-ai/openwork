/**
 * A connection an agent could not use because a person has to connect or
 * reconnect it first. OpenWork Cloud reports this in a capability call's
 * result as a connection status; a run that ended with one did not do what it
 * was asked, whatever the agent wrote afterwards.
 */
export interface ConnectionBlocker {
  connectionId: string;
  connectionName: string;
  state: "needs_connection" | "reauth_required";
}

/** One tool call as a transcript records it: its name and its result or error text. */
export interface ConnectionBlockerToolCall {
  name: string;
  output?: string | null;
  error?: string | null;
}

const MAX_RESULT_LENGTH = 64 * 1_024;
const MAX_NAME_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object in a tool result. The engine may wrap it in a plain error message. */
function parseRecord(text: string | null | undefined): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length > MAX_RESULT_LENGTH) return null;
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  for (const candidate of [trimmed, trimmed.slice(start, end + 1)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON as a whole; try the object inside it.
    }
  }
  return null;
}

/**
 * Reads one connection status. Only OpenWork Cloud's own statuses count (its
 * versioned connection action, or the connection card's payload), so a tool
 * that merely echoes similar JSON is not mistaken for one.
 */
function blockerFrom(value: unknown): ConnectionBlocker | null {
  if (!isRecord(value)) return null;
  const fromCloud = (value.source === "openwork-cloud" && value.kind === "connection_action")
    || value.schemaVersion === "1";
  if (!fromCloud) return null;
  const { connectionId, connectionName, state } = value;
  if (typeof connectionId !== "string" || !connectionId.trim()) return null;
  if (typeof connectionName !== "string" || !connectionName.trim()) return null;
  if (state !== "needs_connection" && state !== "reauth_required") return null;
  // A tool result is not proof of where to go: callers link to OpenWork's own
  // connections page by id rather than to any URL the result carries.
  return { connectionId: connectionId.slice(0, 240), connectionName: connectionName.trim().slice(0, MAX_NAME_LENGTH), state };
}

/**
 * The connection a tool result says must be connected or reconnected, if any.
 * Search results list every connection's status as `matches`; those describe
 * what exists, not what the agent tried to use, so only a status the result
 * reports for itself counts.
 */
export function connectionBlockerFromToolResult(text: string | null | undefined): ConnectionBlocker | null {
  const record = parseRecord(text);
  if (!record) return null;
  for (const candidate of [record, record.connectionStatus, record.connectionAction, record.structuredContent]) {
    const blocker = blockerFrom(candidate);
    if (blocker) return blocker;
  }
  return null;
}

/** The first connection, in call order, that a person must connect or reconnect before the run can do its work. */
export function connectionBlockerFromToolCalls(calls: Iterable<ConnectionBlockerToolCall>): ConnectionBlocker | null {
  for (const call of calls) {
    const blocker = connectionBlockerFromToolResult(call.error) ?? connectionBlockerFromToolResult(call.output);
    if (blocker) return blocker;
  }
  return null;
}

/** What the run's owner reads: which connection and what to do. */
export function connectionBlockerMessage(blocker: ConnectionBlocker): string {
  return blocker.state === "needs_connection"
    ? `${blocker.connectionName} is not connected, so this run could not use it. Connect ${blocker.connectionName} in OpenWork, then run the Automation again.`
    : `${blocker.connectionName} needs to be reconnected, so this run could not use it. Reconnect ${blocker.connectionName} in OpenWork, then run the Automation again.`;
}
