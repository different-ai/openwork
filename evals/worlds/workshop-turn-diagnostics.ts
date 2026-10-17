const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const id = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z0-9_./:-]{1,160}$/.test(value) ? value : undefined;
const code = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : undefined;

/** Allowlist metadata only; never persist prompt/text, tool arguments/results or error messages. */
export function workshopTurnDiagnostic(input: { sessionId: string; messages: unknown; statuses: unknown; permissions: unknown; questions: unknown }) {
  const messages = list(input.messages).slice(-4).map((item) => {
    const message = record(item), info = record(message.info), error = record(info.error), time = record(info.time);
    return { id: id(info.id), role: code(info.role), sessionId: id(info.sessionID), providerID: id(info.providerID), modelID: id(info.modelID), agent: code(info.agent), finish: id(info.finish), errorCode: code(error.name) ?? code(error.code), createdAt: typeof time.created === "number" ? time.created : null, completedAt: typeof time.completed === "number" ? time.completed : null, parts: list(message.parts).slice(-32).map((item) => {
      const part = record(item), state = record(part.state), time = record(state.time), error = record(state.error);
      return { id: id(part.id), type: code(part.type), tool: id(part.tool), callId: id(part.callID), status: code(state.status), start: typeof time.start === "number" ? time.start : null, end: typeof time.end === "number" ? time.end : null, errorCode: code(error.name) ?? code(error.code) };
    }) };
  });
  const pending = (items: unknown) => list(items).filter((item) => record(item).sessionID === input.sessionId).slice(-16).map((item) => { const row = record(item), tool = record(row.tool); return { id: id(row.id), sessionId: id(row.sessionID), tool: id(tool.name), callId: id(tool.callID) }; });
  const status = record(record(input.statuses)[input.sessionId]);
  return { schemaVersion: 1, sessionId: id(input.sessionId), status: { type: code(status.type), attempt: typeof status.attempt === "number" ? status.attempt : null }, messages, pendingPermissions: pending(input.permissions), pendingQuestions: pending(input.questions) };
}

export function workshopTurnTerminal(messages: unknown, previousIds: Set<unknown>): boolean {
  const fresh = list(messages).map(record).filter((message) => record(message.info).role === "assistant" && !previousIds.has(record(message.info).id));
  const info = record(fresh.at(-1)?.info);
  return Boolean(fresh.length && (info.error || (typeof info.finish === "string" && info.finish !== "tool-calls" && info.finish !== "unknown" && typeof record(info.time).completed === "number")));
}
