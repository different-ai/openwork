import { expect } from "vitest";
import { createNativeConnector, denFetch, type DenSession } from "@openwork/behaviors";
import { startMockGoogle } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

// OAuth/discovery journeys do not cover this management journey: a member
// selects one native account and performs actual provider mutations via MCP.
test("connected service actions reach only the selected account and enforce write boundaries", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun", "pnpm"], placement: "local" });
  const primary = "primary@example.test";
  const selected = "selected@example.test";
  const readonly = "readonly@example.test";
  await using provider = await startMockGoogle({ accounts: [primary, selected, readonly], port: 0 });
  const organizationName = `Service Actions ${Date.now()}`;
  await using den = await server({
    place, web: false, org: { name: organizationName, members: { writer: {}, reader: {} } },
    env: {
      DEN_GOOGLE_OAUTH_AUTHORIZE_URL: provider.authorizeUrl,
      DEN_GOOGLE_OAUTH_TOKEN_URL: provider.tokenUrl,
      DEN_GOOGLE_OAUTH_USERINFO_URL: provider.userinfoUrl,
      DEN_GOOGLE_API_BASE_URL: provider.apiUrl,
      DEN_MICROSOFT_OAUTH_AUTHORIZE_URL: `${provider.authorizeUrl}?tenantId={tenantId}`,
      DEN_MICROSOFT_OAUTH_TOKEN_URL: `${provider.tokenUrl}?tenantId={tenantId}`,
      DEN_MICROSOFT_GRAPH_BASE_URL: `${provider.apiUrl}/v1.0`,
    },
  });
  expect(den.database, "Must cold-boot an owned isolated database, never attach a shared Den").toBeDefined();
  const writer = den.members.writer;
  const reader = den.members.reader;
  const writeFeatures = ["gmailManage", "calendarWrite", "sheetsWrite", "driveFile"];
  const connect = async (member: DenSession, providerKey: string, name: string, features: string[], email: string, legacy = false) => {
    const connection = legacy ? { id: providerKey, name } : await createNativeConnector(den.admin, {
      providerKey, name, features, clientId: `synthetic-${name}`, clientSecret: "synthetic-service-actions-secret",
    });
    if (legacy || providerKey === "microsoft-365") {
      const configured = await denFetch(den.admin, `/v1/oauth-providers/${connection.id}/client`, {
        method: "POST", headers: { authorization: `Bearer ${den.admin.token}` },
        body: JSON.stringify({
          ...(legacy ? { features, clientId: `synthetic-${name}`, clientSecret: "synthetic-service-actions-secret" } : {}),
          ...(providerKey === "microsoft-365" ? { tenantId: "12345678-1234-1234-1234-123456789abc" } : {}),
        }),
      });
      expect(configured.response.status, configured.text).toBe(200);
      expect(configured.body).toMatchObject({ providerId: connection.id });
    }
    const started = await denFetch(member, `/v1/mcp-connections/${connection.id}/connect/start`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(started.response.status, started.text).toBe(200);
    const authorize = new URL(text(record(started.body).authorizeUrl));
    expect(`${authorize.origin}${authorize.pathname}`).toBe(provider.authorizeUrl);
    // Exercise the real native OAuth callback, not a seeded token table.
    authorize.searchParams.set("prompt", "select_account");
    const page = await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    expect(page.status).toBe(200);
    await provider.chooseAccount(email, { timeoutMs: 30_000 });
    const status = await denFetch(member, `/v1/oauth-providers/${connection.id}/status`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(status.response.status, status.text).toBe(200);
    expect(status.body).toMatchObject({ connected: true, externalAccountId: email });
    return connection;
  };
  const first = await connect(writer, "google-workspace", "Primary Google", writeFeatures, primary);
  const google = await connect(writer, "google-workspace", "Selected Google", writeFeatures, selected);
  const readGoogle = await connect(reader, "google-workspace", "Readonly Google", ["gmailRead", "calendarRead", "sheetsRead", "driveRead"], readonly);
  const microsoft = await connect(writer, "microsoft-365", "Selected Outlook", ["mailSend", "mailRead", "mailDraft", "mailManage", "calendarWrite", "filesWrite"], selected);
  const readMicrosoft = await connect(reader, "microsoft-365", "Readonly Outlook", ["mailRead", "calendarRead", "filesRead"], readonly);
  expect(google.id).not.toBe(first.id);

  async function mint(member: DenSession, scopes = ["mcp:read", "mcp:write"]) {
    const response = await denFetch(member, "/v1/mcp/token", {
      method: "POST", headers: { authorization: `Bearer ${member.token}` }, body: JSON.stringify({ scopes }),
    });
    expect(response.response.status, response.text).toBe(200);
    expect(record(response.body).scopes).toEqual(scopes);
    return text(record(response.body).token);
  }
  const writerToken = await mint(writer);
  const readScopeToken = await mint(writer, ["mcp:read"]);
  const readerToken = await mint(reader);
  let requestId = 0;
  async function gateway(token: string, name: string, args: Record<string, unknown>) {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    const line = raw.split("\n").find((value) => value.startsWith("data:"));
    const rpc = record(JSON.parse(line ? line.slice(5) : raw));
    expect(rpc.error, JSON.stringify(rpc.error)).toBeUndefined();
    const result = record(rpc.result);
    return { result, payload: record(JSON.parse(text(rows(result.content)[0]?.text))) };
  }
  const found = new Map<string, Record<string, unknown>>();
  async function discover(connection: { id: string; name: string }, providerKey: string, suffix: string, methods: string[], token = writerToken) {
    const path = `/v1/capabilities/${providerKey}/${suffix}`;
    // Search is relevance-ranked and capped at 20, not an exact URL lookup.
    // Avoid common API-prefix words crowding out the selected resource.
    const search = await gateway(token, "search_capabilities", { query: `${connection.name} ${suffix}`, type: "api", limit: 20 });
    expect(search.result.isError, JSON.stringify(search.payload)).not.toBe(true);
    const matches = rows(search.payload.matches).filter((match) => text(match.name).startsWith(`native:${connection.id}:`) && match.path === path);
    for (const method of methods) {
      const exact = matches.filter((match) => match.method === method);
      expect(exact, `Discovery must retain ${method} ${path} for ${connection.id}: ${JSON.stringify(rows(search.payload.matches).map(({ name, method, path }) => ({ name, method, path })))}`).toHaveLength(1);
      const match = exact[0];
      const previous = found.get(text(match.name));
      if (previous) expect([previous.method, previous.path]).toEqual([method, path]);
      found.set(text(match.name), match);
    }
    return matches;
  }
  // Explicit public paths protect the catalog against singular/plural name
  // collisions; nothing imports route code or computes the expected names.
  const googleOperations: [string, string[]][] = [
    ["gmail-draft/{draftId}/send", ["POST"]], ["gmail-drafts", ["GET", "POST"]],
    ["gmail-draft/{draftId}", ["GET", "PUT", "DELETE"]],
    ["gmail-message/{messageId}/modify", ["POST"]], ["gmail-message/{messageId}/trash", ["POST"]],
    ["gmail-message/{messageId}/untrash", ["POST"]], ["gmail-labels", ["GET", "POST"]],
    ["gmail-label/{labelId}", ["PATCH", "DELETE"]],
    ["calendar-events/{eventId}", ["GET", "PATCH", "DELETE"]],
    ["spreadsheets/{spreadsheetId}", ["GET"]], ["spreadsheets", ["POST"]],
    ["spreadsheets/{spreadsheetId}/values", ["GET", "PUT"]], ["spreadsheets/{spreadsheetId}/values/append", ["POST"]],
    ["drive-folders", ["POST"]], ["drive-files/{fileId}", ["GET", "PATCH"]],
  ];
  const microsoftOperations: [string, string[]][] = [
    ["mail-drafts/{messageId}/send", ["POST"]], ["mail-message/{messageId}/reply-draft", ["POST"]],
    ["mail-message/{messageId}", ["PATCH"]], ["mail-message/{messageId}/move", ["POST"]],
    ["calendar-events/{eventId}", ["PATCH", "DELETE"]], ["calendar-events/{eventId}/cancel", ["POST"]],
    ["drive-file/{itemId}", ["PATCH"]], ["drive-folders", ["POST"]],
  ];
  for (const [suffix, methods] of googleOperations) await discover(google, "google-workspace", suffix, methods);
  for (const [suffix, methods] of microsoftOperations) await discover(microsoft, "microsoft-365", suffix, methods);
  expect(found.size).toBe(33);
  evidence.recordAssertionEvidence("All new native operation paths are discoverable without tool-name collisions", "Gateway search returned one exact connector-namespaced method/path match for each of 33 operations (32 new and existing Gmail draft creation); no name mapped to another path or method.", true);

  const snapshot = async (email: string) => {
    const response = await fetch(`${provider.apiUrl}/__mock-google/actions?email=${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    return record(await response.json());
  };
  const untouched = await snapshot(primary);
  const readerBefore = await snapshot(readonly);
  type Action = {
    method: string; suffix: string; path?: Record<string, string>; query?: Record<string, string>;
    body?: Record<string, unknown>; unconfirmed?: Record<string, unknown>; unconfirmedQuery?: Record<string, string>;
    providerPath: string; providerBody?: unknown; providerQuery?: Record<string, string>; preflight?: boolean;
    receipt: Record<string, unknown>; state?: Record<string, unknown>;
  };
  const raw = Buffer.from("To: recipient@example.test\r\nSubject: Revised\r\n\r\nRevised draft").toString("base64url");
  const fileQuery = { fields: "id,name,mimeType,trashed,parents,webViewLink", supportsAllDrives: "true" };
  const spreadsheetFields = "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))";
  const googleCases: Action[] = [
    { method: "POST", suffix: "gmail-message/{messageId}/modify",
      path: { messageId: "message-1" }, body: { addLabelIds: ["STARRED"], removeLabelIds: ["INBOX", "UNREAD"] },
      providerPath: "/gmail/v1/users/me/messages/message-1/modify", providerBody: { addLabelIds: ["STARRED"], removeLabelIds: ["INBOX", "UNREAD"] }, providerQuery: {},
      receipt: { id: "message-1", threadId: "thread-1", labelIds: ["STARRED"] }, state: { labelIds: ["STARRED"] } },
    { method: "POST", suffix: "gmail-message/{messageId}/trash", path: { messageId: "message-1" }, body: { confirm: true }, unconfirmed: {},
      providerPath: "/gmail/v1/users/me/messages/message-1/trash", receipt: { id: "message-1", labelIds: ["STARRED", "TRASH"] }, state: { labelIds: ["STARRED", "TRASH"] } },
    { method: "POST", suffix: "gmail-message/{messageId}/untrash", path: { messageId: "message-1" },
      providerPath: "/gmail/v1/users/me/messages/message-1/untrash", receipt: { id: "message-1", labelIds: ["STARRED"] }, state: { labelIds: ["STARRED"] } },
    { method: "GET", suffix: "gmail-drafts", query: { maxResults: "2", q: "in:drafts", includeSpamTrash: "false" },
      providerPath: "/gmail/v1/users/me/drafts", providerQuery: { maxResults: "2", q: "in:drafts", includeSpamTrash: "false" },
      receipt: { drafts: [{ id: "draft-1" }, { id: "draft-2" }], resultSizeEstimate: 2 } },
    { method: "PUT", suffix: "gmail-draft/{draftId}", path: { draftId: "draft-1" },
      body: { confirm: true, message: { raw, threadId: "thread-1" } }, unconfirmed: { message: { raw } },
      providerPath: "/gmail/v1/users/me/drafts/draft-1", providerBody: { message: { raw, threadId: "thread-1" } },
      receipt: { id: "draft-1", message: { raw, threadId: "thread-1" } }, state: { draftMessage: { raw, threadId: "thread-1" }, sent: [] } },
    { method: "GET", suffix: "gmail-draft/{draftId}", path: { draftId: "draft-1" }, query: { format: "raw" },
      providerPath: "/gmail/v1/users/me/drafts/draft-1", providerQuery: { format: "raw" }, receipt: { id: "draft-1", message: { raw, threadId: "thread-1" } } },
    { method: "DELETE", suffix: "gmail-draft/{draftId}", path: { draftId: "draft-2" }, body: { confirm: true }, unconfirmed: {},
      providerPath: "/gmail/v1/users/me/drafts/draft-2", receipt: { ok: true }, state: { draftIds: ["draft-1"], sent: [] } },
    { method: "POST", suffix: "gmail-draft/{draftId}/send",
      path: { draftId: "draft-1" }, body: { confirm: true }, unconfirmed: {},
      providerPath: "/gmail/v1/users/me/drafts/send", providerBody: { id: "draft-1" }, receipt: { id: "sent-1", threadId: "thread-1" }, state: { draftIds: [], sent: ["sent-1"] } },
    { method: "POST", suffix: "gmail-labels", body: { name: "Review", labelListVisibility: "labelShow" },
      providerPath: "/gmail/v1/users/me/labels", providerBody: { name: "Review", labelListVisibility: "labelShow" },
      receipt: { id: "label-1", name: "Review", type: "user" } },
    { method: "PATCH", suffix: "gmail-label/{labelId}", path: { labelId: "label-1" }, body: { name: "Reviewed", messageListVisibility: "hide" }, preflight: true,
      providerPath: "/gmail/v1/users/me/labels/label-1", providerBody: { name: "Reviewed", messageListVisibility: "hide" },
      receipt: { id: "label-1", name: "Reviewed", type: "user", messageListVisibility: "hide" } },
    { method: "GET", suffix: "gmail-labels", providerPath: "/gmail/v1/users/me/labels",
      receipt: { labels: [{ id: "INBOX", type: "system" }, { id: "label-1", name: "Reviewed", type: "user" }] } },
    { method: "DELETE", suffix: "gmail-label/{labelId}", path: { labelId: "label-1" }, body: { confirm: true }, unconfirmed: {}, preflight: true,
      providerPath: "/gmail/v1/users/me/labels/label-1", receipt: { ok: true }, state: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }], labelIds: ["STARRED"] } },
    { method: "PATCH", suffix: "calendar-events/{eventId}", path: { eventId: "event-1" },
      body: { summary: "After", start: { date: "2026-10-01" }, end: { date: "2026-10-02" }, attendees: [], sendUpdates: "all", confirmNotifications: true },
      unconfirmed: { summary: "After", sendUpdates: "all" },
      providerPath: "/calendar/v3/calendars/primary/events/event-1",
      providerBody: { summary: "After", start: { date: "2026-10-01" }, end: { date: "2026-10-02" }, attendees: [] }, providerQuery: { sendUpdates: "all", maxAttendees: "100" },
      receipt: { ok: true, event: { id: "event-1", status: "confirmed", summary: "After", start: { date: "2026-10-01" }, end: { date: "2026-10-02" }, attendees: [] }, sendUpdates: "all" } },
    { method: "GET", suffix: "calendar-events/{eventId}", path: { eventId: "event-1" },
      providerPath: "/calendar/v3/calendars/primary/events/event-1", providerQuery: { maxAttendees: "100" }, receipt: { ok: true, calendarId: "primary", event: { id: "event-1", summary: "After" } } },
    { method: "DELETE", suffix: "calendar-events/{eventId}", path: { eventId: "event-1" },
      query: { confirmCancellation: "true", sendUpdates: "externalOnly", confirmNotifications: "true" }, unconfirmedQuery: { confirmCancellation: "true", sendUpdates: "externalOnly" },
      providerPath: "/calendar/v3/calendars/primary/events/event-1", providerQuery: { sendUpdates: "externalOnly" },
      receipt: { ok: true, eventId: "event-1", cancelled: true, sendUpdates: "externalOnly" }, state: { event: { status: "cancelled" } } },
    { method: "POST", suffix: "spreadsheets", body: { title: "Action sheet", sheetTitle: "Sheet1", rowCount: 10, columnCount: 2 },
      providerPath: "/v4/spreadsheets", providerQuery: { fields: spreadsheetFields },
      providerBody: { properties: { title: "Action sheet" }, sheets: [{ properties: { title: "Sheet1", gridProperties: { rowCount: 10, columnCount: 2 } } }] },
      receipt: { ok: true, spreadsheet: { spreadsheetId: "sheet-1", properties: { title: "Action sheet" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1", gridProperties: { rowCount: 10, columnCount: 2 } } }] } } },
    { method: "GET", suffix: "spreadsheets/{spreadsheetId}", path: { spreadsheetId: "sheet-1" },
      providerPath: "/v4/spreadsheets/sheet-1", providerQuery: { fields: spreadsheetFields, includeGridData: "false" },
      receipt: { ok: true, spreadsheet: { spreadsheetId: "sheet-1", properties: { title: "Action sheet" } } } },
    { method: "PUT", suffix: "spreadsheets/{spreadsheetId}/values",
      path: { spreadsheetId: "sheet-1" }, body: { range: "Sheet1!A1:B1", values: [["=1+1", 7]] },
      unconfirmed: { range: "Sheet1!A1:B1", values: [["=1+1", 7]], valueInputOption: "USER_ENTERED" },
      providerPath: "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B1", providerBody: { range: "Sheet1!A1:B1", majorDimension: "ROWS", values: [["=1+1", 7]] },
      providerQuery: { valueInputOption: "RAW" }, receipt: { ok: true, spreadsheetId: "sheet-1", updatedCells: 2, valueInputOption: "RAW" }, state: { values: [["=1+1", 7]] } },
    { method: "POST", suffix: "spreadsheets/{spreadsheetId}/values/append", path: { spreadsheetId: "sheet-1" },
      body: { range: "Sheet1!A1:B1", values: [["Next", true]] },
      providerPath: "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B1:append", providerQuery: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
      providerBody: { range: "Sheet1!A1:B1", majorDimension: "ROWS", values: [["Next", true]] },
      receipt: { ok: true, spreadsheetId: "sheet-1", updatedRange: "Sheet1!A2:B2", updatedRows: 1, updatedColumns: 2, updatedCells: 2, tableRange: "Sheet1!A1:B1", valueInputOption: "RAW" },
      state: { values: [["=1+1", 7], ["Next", true]] } },
    { method: "GET", suffix: "spreadsheets/{spreadsheetId}/values", path: { spreadsheetId: "sheet-1" }, query: { range: "Sheet1!A1:B2", valueRenderOption: "UNFORMATTED_VALUE" },
      providerPath: "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B2", providerQuery: { majorDimension: "ROWS", valueRenderOption: "UNFORMATTED_VALUE" },
      receipt: { ok: true, spreadsheetId: "sheet-1", range: "Sheet1!A1:B2", values: [["=1+1", 7], ["Next", true]], valueRenderOption: "UNFORMATTED_VALUE" } },
    { method: "POST", suffix: "drive-folders", body: { name: "Review", parentId: "parent-2" },
      providerPath: "/drive/v3/files", providerQuery: fileQuery, providerBody: { name: "Review", mimeType: "application/vnd.google-apps.folder", parents: ["parent-2"] },
      receipt: { ok: true, file: { id: "folder-1", name: "Review", mimeType: "application/vnd.google-apps.folder", parents: ["parent-2"], trashed: false } } },
    { method: "PATCH", suffix: "drive-files/{fileId}", path: { fileId: "file-1" },
      body: { name: "After.txt", addParentId: "parent-2", removeParentId: "parent-1", trashed: true, confirmTrash: true }, unconfirmed: { trashed: true },
      providerPath: "/drive/v3/files/file-1", providerQuery: { ...fileQuery, addParents: "parent-2", removeParents: "parent-1" }, providerBody: { name: "After.txt", trashed: true },
      receipt: { ok: true, file: { id: "file-1", name: "After.txt", parents: ["parent-2"], trashed: true } } },
    { method: "GET", suffix: "drive-files/{fileId}", path: { fileId: "file-1" }, providerPath: "/drive/v3/files/file-1", providerQuery: fileQuery,
      receipt: { ok: true, file: { id: "file-1", name: "After.txt", parents: ["parent-2"], trashed: true } } },
  ];
  const microsoftCases: Action[] = [
    { method: "POST", suffix: "mail-drafts/{messageId}/send",
      path: { messageId: "outlook-draft-1" }, body: { confirmSend: true }, unconfirmed: {},
      providerPath: "/v1.0/me/messages/outlook-draft-1/send", providerBody: null, providerQuery: {},
      receipt: { ok: true, draftId: "outlook-draft-1", status: "accepted" }, state: { outlookDraftIds: [], outlookAccepted: ["outlook-draft-1"] } },
    { method: "POST", suffix: "mail-message/{messageId}/reply-draft", path: { messageId: "outlook-message-1" }, body: { comment: "Reply for review" },
      providerPath: "/v1.0/me/messages/outlook-message-1/createReply", providerBody: { comment: "Reply for review" },
      receipt: { ok: true, draft: { id: "outlook-reply-1", conversationId: "conversation-1", isDraft: true, body: "Reply for review" } },
      state: { outlookDraftIds: ["outlook-reply-1"], outlookAccepted: ["outlook-draft-1"] } },
    { method: "PATCH", suffix: "mail-message/{messageId}", path: { messageId: "outlook-message-1" }, body: { isRead: true, categories: ["Reviewed"] },
      providerPath: "/v1.0/me/messages/outlook-message-1", providerBody: { isRead: true, categories: ["Reviewed"] },
      receipt: { ok: true, message: { id: "outlook-message-1", isRead: true, categories: ["Reviewed"] } } },
    { method: "POST", suffix: "mail-message/{messageId}/move", path: { messageId: "outlook-message-1" }, body: { destination: "deleteditems", confirmTrash: true }, unconfirmed: { destination: "deleteditems" },
      providerPath: "/v1.0/me/messages/outlook-message-1/move", providerBody: { destinationId: "deleteditems" },
      receipt: { ok: true, message: { id: "outlook-moved-1", parentFolderId: "deleteditems", isRead: true, categories: ["Reviewed"] } } },
    { method: "PATCH", suffix: "calendar-events/{eventId}", path: { eventId: "outlook-event-1" },
      body: { confirmNotifications: true, subject: "After", body: "Agenda", location: "Room 1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z" }, unconfirmed: { subject: "After" },
      providerPath: "/v1.0/me/events/outlook-event-1", providerBody: { subject: "After", body: { contentType: "Text", content: "Agenda" }, location: { displayName: "Room 1" },
        start: { dateTime: "2026-10-01T10:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-01T11:00:00Z", timeZone: "UTC" } },
      receipt: { ok: true, event: { id: "outlook-event-1", subject: "After", location: "Room 1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T11:00:00Z", startTimeZone: "UTC", endTimeZone: "UTC" } },
      state: { outlookEvent: { subject: "After", body: { contentType: "Text", content: "Agenda" } } } },
    { method: "POST", suffix: "calendar-events/{eventId}/cancel", path: { eventId: "outlook-event-1" }, body: { confirmCancel: true, comment: "Cancelled" }, unconfirmed: { comment: "Cancelled" },
      providerPath: "/v1.0/me/events/outlook-event-1/cancel", providerBody: { comment: "Cancelled" },
      receipt: { ok: true, eventId: "outlook-event-1", status: "accepted" }, state: { outlookCancelled: ["outlook-event-1"] } },
    { method: "DELETE", suffix: "calendar-events/{eventId}", path: { eventId: "outlook-event-1" }, body: { confirmDelete: true }, unconfirmed: {},
      providerPath: "/v1.0/me/events/outlook-event-1", receipt: { ok: true, eventId: "outlook-event-1", status: "deleted" }, state: { outlookDeleted: ["outlook-event-1"] } },
    { method: "PATCH", suffix: "drive-file/{itemId}", path: { itemId: "item-1" }, body: { name: "After.txt", parentId: "parent-2" },
      providerPath: "/v1.0/me/drive/items/item-1", providerBody: { name: "After.txt", parentReference: { id: "parent-2" } },
      receipt: { ok: true, file: { id: "item-1", name: "After.txt", kind: "file" } }, state: { onedriveFile: { name: "After.txt", parentReference: { id: "parent-2" } } } },
    { method: "POST", suffix: "drive-folders", body: { name: "Review", parentId: "parent-2" },
      providerPath: "/v1.0/me/drive/items/parent-2/children", providerBody: { name: "Review", folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
      receipt: { ok: true, file: { id: "onedrive-folder-1", name: "Review", kind: "folder" } }, state: { onedriveFolders: [{ id: "onedrive-folder-1", name: "Review", parentReference: { id: "parent-2" } }] } },
  ];
  const cases = [
    ...googleCases.map((action) => ({ ...action, providerKey: "google-workspace", connection: google, readConnection: readGoogle })),
    ...microsoftCases.map((action) => ({ ...action, providerKey: "microsoft-365", connection: microsoft, readConnection: readMicrosoft })),
  ];
  expect(new Set(cases.map((action) => `${action.providerKey} ${action.method} ${action.suffix}`)).size).toBe(32);
  const selectedTokens = new Map<string, string>();
  for (const action of cases) {
    const fullPath = `/v1/capabilities/${action.providerKey}/${action.suffix}`;
    const match = [...found.values()].find((entry) => text(entry.name).startsWith(`native:${action.connection.id}:`) && entry.method === action.method && entry.path === fullPath);
    if (!match) throw new Error(`Missing discovered action ${action.method} ${fullPath}`);
    expect(match.hasBody).toBe(action.body !== undefined);
    // The gateway returns the OpenAPI schema unchanged, including named refs.
    if (action.body) {
      if (action.providerKey === "microsoft-365") {
        expect(record(match.bodySchema).$ref).toMatch(/^#\/components\/schemas\/Microsoft365/);
      } else {
        expect(record(match.bodySchema).type).toBe("object");
      }
    }
    expect(match.pathParams).toEqual(Object.keys(action.path ?? {}));
    const args = { name: text(match.name), path: action.path, query: action.query, body: action.body };
    const before = await snapshot(selected);
    if (action.method !== "GET") {
      const denied = await gateway(readScopeToken, "execute_capability", args);
      expect(denied.result.isError).toBe(true);
      expect(denied.payload).toMatchObject({ error: "insufficient_mcp_scope", requiredScope: "mcp:write" });
      expect(await snapshot(selected)).toEqual(before);
      const readerMatches = await discover(action.readConnection, action.providerKey, action.suffix, [action.method], readerToken);
      const readerMatch = readerMatches.find((entry) => entry.method === action.method);
      if (!readerMatch) throw new Error("Read-only member's operation missing");
      const deniedGrant = await gateway(readerToken, "execute_capability", { ...args, name: readerMatch.name });
      expect(deniedGrant.result.isError).toBe(true);
      expect(deniedGrant.payload).toMatchObject({ error: "needs_connection" });
      expect(await snapshot(selected)).toEqual(before);
      expect((await snapshot(readonly)).state).toEqual(readerBefore.state);
      expect((await snapshot(readonly)).requests).toEqual([]);
    }
    if (action.unconfirmed || action.unconfirmedQuery) {
      const rejected = await gateway(writerToken, "execute_capability", { ...args,
        body: action.unconfirmed ?? action.body, query: action.unconfirmedQuery ?? action.query });
      expect(rejected.result.isError).toBe(true);
      expect(rejected.payload).toMatchObject({ error: "invalid_request" });
      expect(await snapshot(selected)).toEqual(before);
    }
    const executed = await gateway(action.method === "GET" ? readScopeToken : writerToken, "execute_capability", args);
    expect(executed.result.isError, JSON.stringify(executed.payload)).not.toBe(true);
    expect(executed.payload).toMatchObject(action.receipt);
    const after = await snapshot(selected);
    const observed = rows(after.requests).slice(rows(before.requests).length);
    const expected = { method: action.method, path: action.providerPath, query: action.providerQuery ?? {},
      body: action.providerBody ?? null, email: selected, tokenId: expect.stringMatching(/^[a-f0-9]{12}$/) };
    expect(observed).toEqual(action.preflight ? [{ ...expected, method: "GET", body: null }, expected] : [expected]);
    expect(after.totalRequests).toBe(Number(before.totalRequests) + observed.length);
    for (const request of observed) {
      const token = text(request.tokenId);
      if (!selectedTokens.has(action.connection.id)) selectedTokens.set(action.connection.id, token);
      expect(token).toBe(selectedTokens.get(action.connection.id));
    }
    if (action.method === "GET") expect(after.state).toEqual(before.state);
    if (action.state) expect(after.state).toMatchObject(action.state);
    expect((await snapshot(primary)).state).toEqual(untouched.state);
    expect((await snapshot(primary)).requests).toEqual([]);
    evidence.recordAssertionEvidence(`${action.providerKey} ${action.method} ${action.suffix} uses only the selected account`,
      action.method === "GET"
        ? "Read-scoped execution returned the provider state through the exact authenticated method/path/query, without changing any account."
        : "MCP write-scope, provider-grant, and applicable confirmation denials produced zero provider calls. Authorized execution matched the exact method/path/query/body and selected credential, including any label-type preflight; the other accounts stayed unchanged.", true);
  }
  const completed = await snapshot(selected);
  expect(completed.state).toMatchObject({ labelIds: ["STARRED"], draftIds: [], sent: ["sent-1"],
    event: { id: "event-1", status: "cancelled", summary: "After" }, values: [["=1+1", 7], ["Next", true]],
    folders: [{ id: "folder-1", name: "Review", parents: ["parent-2"] }], file: { id: "file-1", name: "After.txt", trashed: true, parents: ["parent-2"] },
    outlookDraftIds: ["outlook-reply-1"], outlookAccepted: ["outlook-draft-1"],
    outlookMessage: { id: "outlook-moved-1", parentFolderId: "deleteditems", isRead: true, categories: ["Reviewed"] },
    outlookReply: { id: "outlook-reply-1", isDraft: true, conversationId: "conversation-1", body: { content: "Reply for review" } },
    outlookEvent: null,
    outlookCancelled: ["outlook-event-1"], outlookDeleted: ["outlook-event-1"] });
  expect(completed.totalRequests).toBe(34);
  expect(new Set(selectedTokens.values()).size).toBe(2);
  expect((await snapshot(readonly)).state).toEqual(readerBefore.state);
  evidence.recordAssertionEvidence("All 32 new native operations execute against stateful synthetic providers", "Seven reads and 25 writes produced 34 exact provider requests (two user-label preflights). Readbacks reflect previous writes; send consumes drafts, reply stays unsent, moves preserve account identity, and cancellation/deletion have distinct receipts. Google and Microsoft use distinct selected credentials; neither other account changed.", true);
  for (const method of ["PATCH", "DELETE"]) {
    const match = [...found.values()].find((entry) => text(entry.name).startsWith(`native:${google.id}:`) && entry.method === method
      && entry.path === "/v1/capabilities/google-workspace/gmail-label/{labelId}");
    if (!match) throw new Error("Missing label action");
    const before = await snapshot(selected);
    const denied = await gateway(writerToken, "execute_capability", { name: match.name, path: { labelId: "INBOX" }, body: method === "PATCH" ? { name: "Forbidden" } : { confirm: true } });
    expect(denied.result.isError).toBe(true);
    expect(denied.payload).toMatchObject({ error: "protected_label" });
    const after = await snapshot(selected);
    expect(after.state).toEqual(before.state);
    expect(after.totalRequests).toBe(Number(before.totalRequests) + 1);
    expect(rows(after.requests).slice(rows(before.requests).length)).toEqual([{ method: "GET", path: "/gmail/v1/users/me/labels/INBOX", query: {}, body: null,
      email: selected, tokenId: selectedTokens.get(google.id) }]);
  }
  evidence.recordAssertionEvidence("Gmail system labels cannot be renamed or deleted", "Both operations read the selected label type and return protected_label. Only the authenticated GET reaches the provider; no mutation or state change occurs.", true);

  // Legacy defaults and selected connectors must obey the same organization switch.
  const legacyGoogle = await connect(writer, "google-workspace", "Google Workspace", writeFeatures, selected, true);
  const legacyMicrosoft = await connect(writer, "microsoft-365", "Microsoft 365", ["filesWrite"], selected, true);
  const policyConnections = [
    { connection: google, providerKey: "google-workspace", providerPath: "/drive/v3/files" },
    { connection: microsoft, providerKey: "microsoft-365", providerPath: "/v1.0/me/drive/items/parent-2/children" },
    { connection: legacyGoogle, providerKey: "google-workspace", providerPath: "/drive/v3/files" },
    { connection: legacyMicrosoft, providerKey: "microsoft-365", providerPath: "/v1.0/me/drive/items/parent-2/children" },
  ];
  const policyMatches = new Map<string, Record<string, unknown>>();
  const folderBody = { name: "Policy recovery", parentId: "parent-2" };
  const folderReceipt = { ok: true, file: { name: folderBody.name } };
  const policyDenial = { error: "policy_blocked", message: "Connect is disabled for this organization. Ask your administrator to have it re-enabled." };
  for (const { connection, providerKey } of policyConnections) {
    const [match] = await discover(connection, providerKey, "drive-folders", ["POST"]);
    expect(match).toBeDefined();
    expect(typeof match.scriptPath).toBe("string");
    policyMatches.set(connection.id, match);
  }
  const legacyConnections = policyConnections.slice(2);
  for (const { connection, providerKey, providerPath } of legacyConnections) {
    const before = await snapshot(selected);
    const executed = await denFetch(writer, `/v1/capabilities/${providerKey}/drive-folders`, {
      method: "POST", headers: { authorization: `Bearer ${writer.token}` }, body: JSON.stringify(folderBody),
    });
    expect(executed.response.status, executed.text).toBe(200);
    expect(executed.body).toMatchObject(folderReceipt);
    const observed = rows((await snapshot(selected)).requests).slice(rows(before.requests).length);
    expect(observed).toEqual([expect.objectContaining({ method: "POST", path: providerPath, email: selected })]);
    selectedTokens.set(connection.id, text(observed[0].tokenId));
  }
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  expect(orgs.response.status, orgs.text).toBe(200);
  const organizationId = text(rows(record(orgs.body).orgs).find((org) => org.name === organizationName)?.id);
  const beforeDisable = await snapshot(selected);
  for (const enabled of [false, true]) {
    const switched = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT", headers: { authorization: `Bearer ${den.admin.token}` },
      body: JSON.stringify({ capabilities: { mcpConnections: enabled } }),
    });
    expect(switched.response.status, switched.text).toBe(200);
    expect(switched.body).toMatchObject({ capabilities: { mcpConnections: enabled } });
    const usable = await denFetch(writer, "/v1/mcp-connections?scope=usable", { headers: { authorization: `Bearer ${writer.token}` } });
    expect(usable.response.status, usable.text).toBe(200);
    const usableIds = rows(record(usable.body).connections).map((entry) => entry.id);
    if (enabled) expect(usableIds).toEqual(expect.arrayContaining(policyConnections.map(({ connection }) => connection.id)));
    else expect(usableIds).toEqual([]);
    const manageable = await denFetch(den.admin, "/v1/mcp-connections?scope=manageable", { headers: { authorization: `Bearer ${den.admin.token}` } });
    expect(manageable.response.status, manageable.text).toBe(200);
    expect(rows(record(manageable.body).connections).map((entry) => entry.id)).toEqual(expect.arrayContaining([google.id, microsoft.id]));
    for (const { connection, providerPath } of policyConnections) {
      const match = policyMatches.get(connection.id);
      if (!match) throw new Error("Missing previously discovered policy action");
      const search = await gateway(writerToken, "search_capabilities", { query: `${connection.name} drive-folders`, type: "api", limit: 20 });
      const nativeNames = rows(search.payload.matches).map((entry) => text(entry.name)).filter((name) => name.startsWith("native:"));
      if (enabled) expect(nativeNames).toContain(match.name);
      else expect(nativeNames).toEqual([]);
      for (const executor of ["execute_capability", "execute_capability_script"]) {
        const before = await snapshot(selected);
        const executed = await gateway(writerToken, executor, executor === "execute_capability"
          ? { name: match.name, body: folderBody }
          : { code: `return await ${text(match.scriptPath)}(input)`, input: { body: folderBody } });
        if (enabled) {
          expect(executed.result.isError, JSON.stringify(executed.payload)).not.toBe(true);
          expect(executed.payload).toMatchObject(folderReceipt);
          const observed = rows((await snapshot(selected)).requests).slice(rows(before.requests).length);
          expect(observed).toEqual([expect.objectContaining({ method: "POST", path: providerPath, email: selected, tokenId: selectedTokens.get(connection.id) })]);
        } else {
          expect(executed.result.isError).toBe(true);
          expect(executed.payload).toMatchObject(executor === "execute_capability" ? policyDenial : { error: "script_failed" });
          expect(executed.payload.connectionStatus).toBeUndefined();
          expect(executed.payload.connectionAction).toBeUndefined();
          expect(JSON.stringify(executed.payload)).not.toMatch(/needs_connection|reauth_required|reconnect|connect your account/i);
          expect(await snapshot(selected)).toEqual(before);
        }
      }
      const config = await denFetch(den.admin, `/v1/oauth-providers/${connection.id}/client`, { headers: { authorization: `Bearer ${den.admin.token}` } });
      expect(config.response.status, config.text).toBe(200);
      expect(config.body).toMatchObject({ configured: true, providerId: connection.id });
      if (!enabled) {
        const saved = await denFetch(den.admin, `/v1/oauth-providers/${connection.id}/client`, {
          method: "POST", headers: { authorization: `Bearer ${den.admin.token}` },
          body: JSON.stringify({ features: record(config.body).features }),
        });
        expect(saved.response.status, saved.text).toBe(200);
        expect(saved.body).toMatchObject({ providerId: connection.id, features: record(config.body).features });
      }
    }
    for (const { connection, providerKey, providerPath } of legacyConnections) {
      const before = await snapshot(selected);
      const executed = await denFetch(writer, `/v1/capabilities/${providerKey}/drive-folders`, {
        method: "POST", headers: { authorization: `Bearer ${writer.token}` }, body: JSON.stringify(folderBody),
      });
      expect(executed.response.status, executed.text).toBe(enabled ? 200 : 403);
      expect(executed.body).toMatchObject(enabled ? folderReceipt : policyDenial);
      if (enabled) {
        const observed = rows((await snapshot(selected)).requests).slice(rows(before.requests).length);
        expect(observed).toEqual([expect.objectContaining({ method: "POST", path: providerPath, email: selected, tokenId: selectedTokens.get(connection.id) })]);
      } else {
        expect(executed.text).not.toMatch(/needs_connection|reauth_required|reconnect|connect your account/i);
        const read = await denFetch(writer, `/v1/capabilities/${providerKey}/${providerKey === "google-workspace" ? "gmail-messages" : "mail-messages"}`, {
          headers: { authorization: `Bearer ${writer.token}` },
        });
        expect(read.response.status, read.text).toBe(403);
        expect(read.body).toMatchObject(policyDenial);
        expect(await snapshot(selected)).toEqual(before);
      }
    }
    for (const { email, initial } of [{ email: primary, initial: untouched }, { email: readonly, initial: readerBefore }]) {
      const account = await snapshot(email);
      expect(account.state).toEqual(initial.state);
      expect(account.requests).toEqual(initial.requests);
    }
    const after = await snapshot(selected);
    if (!enabled) expect(after).toEqual(beforeDisable);
    else {
      expect(after.totalRequests).toBe(Number(beforeDisable.totalRequests) + 10);
      for (const field of ["folders", "onedriveFolders"]) {
        expect(rows(record(after.state)[field])).toHaveLength(rows(record(beforeDisable.state)[field]).length + 5);
      }
    }
    evidence.recordAssertionEvidence(enabled
      ? "Re-enabling native connections restores the same accounts without reconnecting"
      : "Organization disable stops selected and legacy native execution while preserving admin management",
    enabled
      ? "The retained generic and Code Mode capabilities and default REST routes each made exactly one request with their original selected credential. Only the selected account gained ten folders; other accounts stayed unchanged."
      : "The actual admin capability switch hid native search and usable connections. Generic execution and legacy REST reads/writes returned policy_blocked with administrator guidance, not reconnect instructions. Code Mode stayed blocked. No provider call or account change occurred; admins could still list and save client configuration.", true);
  }
  const final = await snapshot(selected);
  for (const { providerKey } of legacyConnections) {
    const disconnected = await denFetch(den.admin, `/v1/capabilities/${providerKey}/drive-folders`, {
      method: "POST", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify(folderBody),
    });
    expect(disconnected.response.status, disconnected.text).toBe(409);
    expect(disconnected.body).toMatchObject({ error: "needs_connection" });
    expect(await snapshot(selected)).toEqual(final);
  }
  evidence.recordAssertionEvidence("Organization policy does not replace genuine native sign-in requirements", "With Connect enabled, the unconnected admin still receives needs_connection and HTTP 409 for both native providers, without reaching either provider.", true);
  for (const [connection, features, action] of [
    [google, ["gmailRead", "calendarRead", "sheetsRead"], cases[0]],
    [microsoft, ["mailRead"], cases[googleCases.length]],
  ] as const) {
    const disabled = await denFetch(den.admin, `/v1/oauth-providers/${connection.id}/client`, {
      method: "POST", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ features }),
    });
    expect(disabled.response.status, disabled.text).toBe(200);
    const path = `/v1/capabilities/${action.providerKey}/${action.suffix}`;
    const match = [...found.values()].find((entry) => entry.path === path && entry.method === action.method);
    if (!match) throw new Error("Missing previously discovered action.");
    const denied = await gateway(writerToken, "execute_capability", { name: match.name, path: action.path, body: action.body });
    expect(denied.result.isError).toBe(true);
    expect(denied.payload).toMatchObject({ error: "needs_connection" });
    expect(await snapshot(selected)).toEqual(final);
  }
  evidence.recordAssertionEvidence("Administrator write revocation is enforced despite previously granted provider tokens", "Disabled Google mailbox management and Microsoft mail sending through the actual selected-client configuration routes. Both previously discovered actions were rejected without any additional provider request or state change.", true);
});
