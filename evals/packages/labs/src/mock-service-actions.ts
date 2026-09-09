import type { IncomingMessage, ServerResponse } from "node:http";

// A deliberately small provider, not a Den substitute. Only exact fixture
// resources exist; valid OAuth credentials identify the account on every call.
export function serviceActionsWitness() {
  const requests: { method: string; path: string; query: Record<string, string>; body: unknown; email: string | null; tokenId: string | null }[] = [];
  const accounts = new Map<string, {
    labelIds: string[]; draftIds: string[]; sent: string[];
    event: Record<string, unknown>; values: unknown[][]; outlookDraftIds: string[]; outlookAccepted: string[];
  }>();
  function account(email: string) {
    let state = accounts.get(email);
    if (!state) {
      state = { labelIds: ["INBOX", "UNREAD"], draftIds: ["draft-1"], sent: [],
        event: { id: "event-1", status: "confirmed", summary: "Before" }, values: [["Before", 0]],
        outlookDraftIds: ["outlook-draft-1"], outlookAccepted: [] };
      accounts.set(email, state);
    }
    return state;
  }
  return {
    snapshot(email: string) { return { requests: requests.filter((entry) => entry.email === email), state: account(email), totalRequests: requests.length }; },
    async handle(request: IncomingMessage, response: ServerResponse, url: URL, email: string | null, tokenId: string | null) {
      const path = decodeURIComponent(url.pathname);
      const known = ["/gmail/v1/users/me/messages/message-1", "/gmail/v1/users/me/messages/message-1/modify",
        "/gmail/v1/users/me/drafts/send", "/calendar/v3/calendars/primary/events/event-1",
        "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B1", "/v1.0/me/messages/outlook-draft-1/send"];
      if (!known.includes(path)) return false;
      const method = request.method ?? "GET";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw ? JSON.parse(raw) : null;
      requests.push({ method, path, query: Object.fromEntries(url.searchParams), body, email, tokenId });
      const reply = (status: number, value?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(value === undefined ? undefined : JSON.stringify(value));
        return true;
      };
      if (!email || !tokenId) return reply(401, { error: "invalid_token" });
      const state = account(email);
      const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
      if (method === "POST" && path.endsWith("/modify") && "addLabelIds" in fields && "removeLabelIds" in fields
        && Array.isArray(fields.addLabelIds) && fields.addLabelIds.every((id) => typeof id === "string")
        && Array.isArray(fields.removeLabelIds) && fields.removeLabelIds.every((id) => typeof id === "string")) {
        const removed = new Set(fields.removeLabelIds);
        state.labelIds = [...new Set([...state.labelIds, ...fields.addLabelIds])].filter((id) => !removed.has(id));
        return reply(200, { id: "message-1", threadId: "thread-1", labelIds: state.labelIds });
      }
      if (method === "GET" && path.endsWith("/messages/message-1")) {
        return reply(200, { id: "message-1", threadId: "thread-1", labelIds: state.labelIds });
      }
      if (method === "POST" && path.endsWith("/drafts/send") && "id" in fields && fields.id === "draft-1") {
        if (!state.draftIds.includes(fields.id)) return reply(404, { error: "draft_not_found" });
        state.draftIds = [];
        state.sent.push("sent-1");
        return reply(200, { id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] });
      }
      if (path.includes("/calendar/v3/") && (method === "PATCH" || method === "GET")) {
        if (method === "PATCH") Object.assign(state.event, fields);
        return reply(200, state.event);
      }
      if (path.includes("/v4/spreadsheets/") && method === "PUT" && "values" in fields && Array.isArray(fields.values)
        && fields.values.every((row) => Array.isArray(row))) {
        state.values = fields.values;
        return reply(200, { spreadsheetId: "sheet-1", updatedRange: "Sheet1!A1:B1", updatedRows: state.values.length,
          updatedColumns: Math.max(...state.values.map((row) => row.length)), updatedCells: state.values.flat().length });
      }
      if (path.includes("/v4/spreadsheets/") && method === "GET") {
        return reply(200, { range: "Sheet1!A1:B1", majorDimension: "ROWS", values: state.values });
      }
      if (path.startsWith("/v1.0/") && method === "POST") {
        if (!state.outlookDraftIds.includes("outlook-draft-1")) return reply(404, { error: "draft_not_found" });
        state.outlookDraftIds = [];
        state.outlookAccepted.push("outlook-draft-1");
        return reply(202);
      }
      return reply(400, { error: "unexpected_provider_request" });
    },
  };
}
