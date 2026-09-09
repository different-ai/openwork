import { expect } from "vitest";
import { createNativeConnector, denFetch, type DenSession } from "@openwork/behaviors";
import { startMockGoogle } from "@openwork/labs";
import { needs, server, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
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
  await using den = await server({
    place, web: false, org: { name: `Service Actions ${Date.now()}`, members: { writer: {}, reader: {} } },
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
  const connect = async (member: DenSession, providerKey: string, name: string, features: string[], email: string) => {
    const connection = await createNativeConnector(den.admin, {
      providerKey, name, features, clientId: `synthetic-${name}`, clientSecret: "synthetic-service-actions-secret",
    });
    if (providerKey === "microsoft-365") {
      const configured = await denFetch(den.admin, `/v1/oauth-providers/${connection.id}/client`, {
        method: "POST", headers: { authorization: `Bearer ${den.admin.token}` },
        body: JSON.stringify({ tenantId: "12345678-1234-1234-1234-123456789abc" }),
      });
      expect(configured.response.status, configured.text).toBe(200);
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
  const readGoogle = await connect(reader, "google-workspace", "Readonly Google", ["gmailRead", "calendarRead", "sheetsRead"], readonly);
  const microsoft = await connect(writer, "microsoft-365", "Selected Outlook", ["mailSend", "mailRead"], selected);
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
  const cases = [
    { providerKey: "google-workspace", connection: google, method: "POST", suffix: "gmail-message/{messageId}/modify",
      path: { messageId: "message-1" }, body: { addLabelIds: ["STARRED"], removeLabelIds: ["INBOX", "UNREAD"] },
      providerPath: "/gmail/v1/users/me/messages/message-1/modify", providerBody: { addLabelIds: ["STARRED"], removeLabelIds: ["INBOX", "UNREAD"] }, providerQuery: {},
      receipt: { id: "message-1", threadId: "thread-1", labelIds: ["STARRED"] } },
    { providerKey: "google-workspace", connection: google, method: "POST", suffix: "gmail-draft/{draftId}/send",
      path: { draftId: "draft-1" }, body: { confirm: true }, unconfirmed: {},
      providerPath: "/gmail/v1/users/me/drafts/send", providerBody: { id: "draft-1" }, providerQuery: {}, receipt: { id: "sent-1", threadId: "thread-1" } },
    { providerKey: "google-workspace", connection: google, method: "PATCH", suffix: "calendar-events/{eventId}",
      path: { eventId: "event-1" }, body: { summary: "After", sendUpdates: "all", confirmNotifications: true }, unconfirmed: { summary: "After", sendUpdates: "all" },
      providerPath: "/calendar/v3/calendars/primary/events/event-1", providerBody: { summary: "After" }, providerQuery: { sendUpdates: "all", maxAttendees: "100" },
      receipt: { ok: true, event: { id: "event-1", status: "confirmed", summary: "After" }, sendUpdates: "all" } },
    { providerKey: "google-workspace", connection: google, method: "PUT", suffix: "spreadsheets/{spreadsheetId}/values",
      path: { spreadsheetId: "sheet-1" }, body: { range: "Sheet1!A1:B1", values: [["=1+1", 7]] },
      unconfirmed: { range: "Sheet1!A1:B1", values: [["=1+1", 7]], valueInputOption: "USER_ENTERED" },
      providerPath: "/v4/spreadsheets/sheet-1/values/Sheet1!A1:B1", providerBody: { range: "Sheet1!A1:B1", majorDimension: "ROWS", values: [["=1+1", 7]] },
      providerQuery: { valueInputOption: "RAW" }, receipt: { ok: true, spreadsheetId: "sheet-1", updatedCells: 2, valueInputOption: "RAW" } },
    { providerKey: "microsoft-365", connection: microsoft, method: "POST", suffix: "mail-drafts/{messageId}/send",
      path: { messageId: "outlook-draft-1" }, body: { confirmSend: true }, unconfirmed: {},
      providerPath: "/v1.0/me/messages/outlook-draft-1/send", providerBody: null, providerQuery: {},
      receipt: { ok: true, draftId: "outlook-draft-1", status: "accepted" } },
  ];
  for (const action of cases) {
    const fullPath = `/v1/capabilities/${action.providerKey}/${action.suffix}`;
    const match = [...found.values()].find((entry) => entry.method === action.method && entry.path === fullPath);
    if (!match) throw new Error(`Missing discovered action ${action.method} ${fullPath}`);
    expect(match.hasBody).toBe(true);
    // The gateway returns the OpenAPI schema unchanged, including named refs.
    if (action.providerKey === "microsoft-365") {
      expect(match.bodySchema).toEqual({ $ref: "#/components/schemas/Microsoft365MailSendBody" });
    } else {
      expect(record(match.bodySchema).type).toBe("object");
    }
    expect(match.pathParams).toEqual(Object.keys(action.path));
    const args = { name: text(match.name), path: action.path, body: action.body };
    const before = await snapshot(selected);
    const denied = await gateway(readScopeToken, "execute_capability", args);
    expect(denied.result.isError).toBe(true);
    expect(denied.payload).toMatchObject({ error: "insufficient_mcp_scope", requiredScope: "mcp:write" });
    expect(await snapshot(selected)).toEqual(before);
    if (action.providerKey === "google-workspace") {
      const readerMatches = await discover(readGoogle, "google-workspace", action.suffix, [action.method], readerToken);
      const readerMatch = readerMatches.find((entry) => entry.method === action.method);
      if (!readerMatch) throw new Error("Read-only member's operation missing");
      const deniedGrant = await gateway(readerToken, "execute_capability", { ...args, name: readerMatch.name });
      expect(deniedGrant.result.isError).toBe(true);
      expect(deniedGrant.payload).toMatchObject({ error: "needs_connection" });
      expect(await snapshot(selected)).toEqual(before);
      expect((await snapshot(readonly)).state).toEqual(readerBefore.state);
      expect((await snapshot(readonly)).requests).toEqual([]);
    }
    if (action.unconfirmed) {
      const rejected = await gateway(writerToken, "execute_capability", { ...args, body: action.unconfirmed });
      expect(rejected.result.isError).toBe(true);
      expect(rejected.payload).toMatchObject({ error: "invalid_request" });
      expect(await snapshot(selected)).toEqual(before);
    }
    const executed = await gateway(writerToken, "execute_capability", args);
    expect(executed.result.isError, JSON.stringify(executed.payload)).not.toBe(true);
    expect(executed.payload).toMatchObject(action.receipt);
    const after = await snapshot(selected);
    expect(after.totalRequests).toBe(Number(before.totalRequests) + 1);
    const observed = rows(after.requests).at(-1);
    expect(observed).toEqual({ method: action.method, path: action.providerPath, query: action.providerQuery,
      body: action.providerBody, email: selected, tokenId: expect.stringMatching(/^[a-f0-9]{12}$/) });
    expect((await snapshot(primary)).state).toEqual(untouched.state);
    expect((await snapshot(primary)).requests).toEqual([]);
    evidence.recordAssertionEvidence(`${action.method} ${action.suffix} crosses the provider boundary only with write authority`,
      "Read-only MCP scope and applicable provider-grant/confirmation denials produced zero HTTP calls. The authorized call produced exactly one authenticated provider request with the exact method, path, query, and body for the selected account, never the other account.", true);
  }
  const final = await snapshot(selected);
  expect(final.state).toEqual({ labelIds: ["STARRED"], draftIds: [], sent: ["sent-1"],
    event: { id: "event-1", status: "confirmed", summary: "After" }, values: [["=1+1", 7]],
    outlookDraftIds: [], outlookAccepted: ["outlook-draft-1"] });
  expect(final.totalRequests).toBe(5);
  expect((await snapshot(readonly)).state).toEqual(readerBefore.state);
  evidence.recordAssertionEvidence("Provider state reflects five actual mutations, not UI text or canned gateway success", "Selected account is archived/read/starred; Gmail draft is consumed into sent mail; Calendar summary changed; Sheets stores literal RAW values; Outlook accepted and consumed its draft (not a delivery claim). Both other accounts remain unchanged.", true);
  for (const [connection, features, action] of [
    [google, ["gmailRead", "calendarRead", "sheetsRead"], cases[0]],
    [microsoft, ["mailRead"], cases[4]],
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
