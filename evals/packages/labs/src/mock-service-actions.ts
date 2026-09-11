import type { IncomingMessage, ServerResponse } from "node:http";

// A deliberately small provider, not a Den substitute. Only exact fixture
// resources exist; valid OAuth credentials identify the account on every call.
export function serviceActionsWitness() {
  const requests: { method: string; path: string; query: Record<string, string>; body: unknown; email: string | null; tokenId: string | null }[] = [];
  const accounts = new Map<string, {
    labelIds: string[]; draftIds: string[]; sent: string[];
    event: Record<string, unknown>; values: unknown[][]; outlookDraftIds: string[]; outlookAccepted: string[];
    draftMessage: Record<string, unknown>; labels: Record<string, unknown>[];
    spreadsheet: Record<string, unknown>; file: Record<string, unknown>; folders: Record<string, unknown>[];
    outlookMessage: Record<string, unknown>; outlookReply: Record<string, unknown> | null;
    outlookEvent: Record<string, unknown> | null; outlookCancelled: string[]; outlookDeleted: string[];
    onedriveFile: Record<string, unknown>; onedriveFolders: Record<string, unknown>[];
  }>();
  function account(email: string) {
    let state = accounts.get(email);
    if (!state) {
      state = { labelIds: ["INBOX", "UNREAD"], draftIds: ["draft-1", "draft-2"], sent: [],
        event: { id: "event-1", status: "confirmed", summary: "Before" }, values: [["Before", 0]],
        outlookDraftIds: ["outlook-draft-1"], outlookAccepted: [],
        draftMessage: { id: "draft-message-1", threadId: "thread-1" },
        labels: [{ id: "INBOX", name: "INBOX", type: "system" }],
        spreadsheet: { spreadsheetId: "sheet-1", spreadsheetUrl: "https://example.test/sheets/sheet-1",
          properties: { title: "Before" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] },
        file: { id: "file-1", name: "Before.txt", mimeType: "text/plain", trashed: false, parents: ["parent-1"] }, folders: [],
        outlookMessage: { id: "outlook-message-1", conversationId: "conversation-1", subject: "Before", isRead: false,
          isDraft: false, categories: [], parentFolderId: "inbox", body: { contentType: "Text", content: "Original" } }, outlookReply: null,
        outlookEvent: { id: "outlook-event-1", subject: "Before" }, outlookCancelled: [], outlookDeleted: [],
        onedriveFile: { id: "item-1", name: "Before.txt", file: { mimeType: "text/plain" }, parentReference: { id: "parent-1" } }, onedriveFolders: [] };
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
        "/gmail/v1/users/me/messages/message-1/trash", "/gmail/v1/users/me/messages/message-1/untrash",
        "/gmail/v1/users/me/drafts", "/gmail/v1/users/me/drafts/draft-1", "/gmail/v1/users/me/drafts/draft-2",
        "/gmail/v1/users/me/labels", "/gmail/v1/users/me/labels/label-1", "/gmail/v1/users/me/labels/INBOX",
        "/v4/spreadsheets", "/v4/spreadsheets/sheet-1", "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B1",
        "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B1:append", "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B2",
        "/drive/v3/files", "/drive/v3/files/file-1", "/v1.0/me/messages/outlook-draft-1/send",
        "/v1.0/me/messages/outlook-message-1", "/v1.0/me/messages/outlook-message-1/createReply", "/v1.0/me/messages/outlook-message-1/move",
        "/v1.0/me/events/outlook-event-1", "/v1.0/me/events/outlook-event-1/cancel",
        "/v1.0/me/drive/items/item-1", "/v1.0/me/drive/items/parent-2/children"];
      if (!known.includes(path)) return false;
      const method = request.method ?? "GET";
      // Preserve the existing MIME/attachment draft-creation witness.
      if (path === "/gmail/v1/users/me/drafts" && method === "POST") return false;
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
      const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
      const fields = isRecord(body) ? body : {};
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
      if (method === "POST" && (path.endsWith("/message-1/trash") || path.endsWith("/message-1/untrash"))) {
        state.labelIds = state.labelIds.filter((id) => id !== "TRASH");
        if (path.endsWith("/trash")) state.labelIds.push("TRASH");
        return reply(200, { id: "message-1", threadId: "thread-1", labelIds: state.labelIds });
      }
      if (method === "GET" && path.endsWith("/drafts")) {
        return reply(200, { drafts: state.draftIds.map((id) => ({ id, message: id === "draft-1" ? state.draftMessage : { id: "draft-message-2", threadId: "thread-2" } })), resultSizeEstimate: state.draftIds.length });
      }
      if (/\/drafts\/draft-[12]$/.test(path)) {
        const id = path.split("/").at(-1);
        if (!id || !state.draftIds.includes(id)) return reply(404, { error: "draft_not_found" });
        if (method === "DELETE") {
          state.draftIds = state.draftIds.filter((draft) => draft !== id);
          return reply(204);
        }
        if (id === "draft-1") {
          if (method === "PUT" && isRecord(fields.message)) Object.assign(state.draftMessage, fields.message);
          if (method === "GET" || method === "PUT") return reply(200, { id, message: state.draftMessage });
        }
      }
      if (method === "POST" && path.endsWith("/drafts/send") && "id" in fields && fields.id === "draft-1") {
        if (!state.draftIds.includes(fields.id)) return reply(404, { error: "draft_not_found" });
        state.draftIds = state.draftIds.filter((id) => id !== fields.id);
        state.sent.push("sent-1");
        return reply(200, { id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] });
      }
      if (path.endsWith("/labels")) {
        if (method === "GET") return reply(200, { labels: state.labels });
        if (method === "POST" && typeof fields.name === "string") {
          const label = { ...fields, id: "label-1", type: "user" };
          state.labels.push(label);
          return reply(200, label);
        }
      }
      if (path.includes("/labels/")) {
        const label = state.labels.find((entry) => entry.id === path.split("/").at(-1));
        if (!label) return reply(404, { error: "label_not_found" });
        if (method === "GET") return reply(200, label);
        if (method === "PATCH") { Object.assign(label, fields); return reply(200, label); }
        if (method === "DELETE") { state.labels = state.labels.filter((entry) => entry !== label); return reply(204); }
      }
      if (path.includes("/calendar/v3/") && method === "DELETE") {
        state.event.status = "cancelled";
        return reply(204);
      }
      if (path.includes("/calendar/v3/") && (method === "PATCH" || method === "GET")) {
        if (method === "PATCH") Object.assign(state.event, fields);
        return reply(200, state.event);
      }
      if (path === "/v4/spreadsheets" && method === "POST") {
        if (!isRecord(fields.properties) || !Array.isArray(fields.sheets)) return reply(400, { error: "invalid_spreadsheet" });
        state.spreadsheet = { ...state.spreadsheet, properties: fields.properties,
          sheets: fields.sheets.filter(isRecord).map((sheet) => ({ properties: { sheetId: 0, ...(isRecord(sheet.properties) ? sheet.properties : {}) } })) };
        return reply(200, state.spreadsheet);
      }
      if (path === "/v4/spreadsheets/sheet-1" && method === "GET") return reply(200, state.spreadsheet);
      if (path.includes("/values/") && (method === "PUT" || (method === "POST" && path.endsWith(":append"))) && "values" in fields && Array.isArray(fields.values)
        && fields.values.every((row) => Array.isArray(row))) {
        const append = method === "POST";
        state.values = append ? [...state.values, ...fields.values] : fields.values;
        const updates = { spreadsheetId: "sheet-1", updatedRange: append ? "Sheet1!A2:B2" : "Sheet1!A1:B1", updatedRows: fields.values.length,
          updatedColumns: Math.max(...fields.values.map((row) => row.length)), updatedCells: fields.values.flat().length };
        return reply(200, append ? { spreadsheetId: "sheet-1", tableRange: "Sheet1!A1:B1", updates } : updates);
      }
      if (path.includes("/values/") && method === "GET") {
        return reply(200, { range: path.split("/values/")[1], majorDimension: "ROWS", values: state.values });
      }
      if (path === "/drive/v3/files" && method === "POST") {
        const folder = { ...fields, id: "folder-1", trashed: false };
        state.folders.push(folder);
        return reply(200, folder);
      }
      if (path === "/drive/v3/files/file-1") {
        if (method === "PATCH") {
          Object.assign(state.file, fields);
          if (url.searchParams.has("addParents")) state.file.parents = [url.searchParams.get("addParents")];
        }
        if (method === "GET" || method === "PATCH") return reply(200, state.file);
      }
      if (path.endsWith("/outlook-draft-1/send") && method === "POST") {
        if (!state.outlookDraftIds.includes("outlook-draft-1")) return reply(404, { error: "draft_not_found" });
        state.outlookDraftIds = state.outlookDraftIds.filter((id) => id !== "outlook-draft-1");
        state.outlookAccepted.push("outlook-draft-1");
        return reply(202);
      }
      if (path.endsWith("/outlook-message-1/createReply") && method === "POST") {
        state.outlookReply = { ...state.outlookMessage, id: "outlook-reply-1", isDraft: true,
          body: { contentType: "Text", content: fields.comment } };
        state.outlookDraftIds.push("outlook-reply-1");
        return reply(201, state.outlookReply);
      }
      if (path.endsWith("/outlook-message-1") && method === "PATCH") {
        Object.assign(state.outlookMessage, fields);
        return reply(200, state.outlookMessage);
      }
      if (path.endsWith("/outlook-message-1/move") && method === "POST") {
        Object.assign(state.outlookMessage, { id: "outlook-moved-1", parentFolderId: fields.destinationId });
        return reply(201, state.outlookMessage);
      }
      if (path.endsWith("/outlook-event-1")) {
        if (!state.outlookEvent) return reply(404, { error: "event_not_found" });
        if (method === "PATCH") { Object.assign(state.outlookEvent, fields); return reply(200, state.outlookEvent); }
        if (method === "DELETE") { state.outlookEvent = null; state.outlookDeleted.push("outlook-event-1"); return reply(204); }
      }
      if (path.endsWith("/outlook-event-1/cancel") && method === "POST") {
        state.outlookCancelled.push("outlook-event-1");
        return reply(202);
      }
      if (path === "/v1.0/me/drive/items/item-1" && method === "PATCH") {
        Object.assign(state.onedriveFile, fields);
        return reply(200, state.onedriveFile);
      }
      if (path === "/v1.0/me/drive/items/parent-2/children" && method === "POST") {
        const folder = { ...fields, id: "onedrive-folder-1", parentReference: { id: "parent-2" } };
        state.onedriveFolders.push(folder);
        return reply(201, folder);
      }
      return reply(400, { error: "unexpected_provider_request" });
    },
  };
}
