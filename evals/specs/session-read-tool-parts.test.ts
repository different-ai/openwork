import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { appWeb, eventually, needs, SkipError, test } from "@openwork/testkit";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { buildOpenworkProviderContributions, sessionActivityArgsSchema, sessionReadArgsSchema, sessionSearchArgsSchema } from "../../apps/server/src/opencode-plugins/openwork-provider-adapters";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object response");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an array response");
  return value.map(record);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string response");
  return value;
}

test("session tool descriptors advertise accepted enums, text defaults, caps and read-only activity", async ({ evidence }) => {
  const affordances = buildOpenworkProviderContributions([]).flatMap((entry) => entry.affordances);
  const read = affordances.find((entry) => entry.id === "session.read");
  const search = affordances.find((entry) => entry.id === "session.search");
  const activity = affordances.find((entry) => entry.id === "session.activity");
  const parts = read?.arguments.find((argument) => argument.name === "parts")?.description;
  const scope = search?.arguments.find((argument) => argument.name === "in")?.description;
  const readEnums = sessionReadArgsSchema.shape.parts.unwrap().element.options;
  const searchEnums = sessionSearchArgsSchema.shape.in.unwrap().element.options;
  expect(readEnums).toEqual(["text", "tool", "reasoning"]);
  expect(searchEnums).toEqual(["text", "tool"]);
  for (const value of readEnums) expect(parts).toContain(value);
  for (const value of searchEnums) expect(scope).toContain(value);
  for (const description of [parts, scope]) {
    expect(description).toContain("default [text]");
    expect(description).toContain("2000");
    expect(description).toContain("redacted");
  }
  expect(sessionReadArgsSchema.parse({ sessionId: "ses_fixture" }).parts).toEqual(["text"]);
  expect(sessionSearchArgsSchema.parse({ query: "needle" }).in).toEqual(["text"]);
  expect(sessionReadArgsSchema.safeParse({ sessionId: "ses_fixture", parts: ["unknown"] }).success).toBe(false);
  expect(sessionSearchArgsSchema.safeParse({ query: "needle", in: ["reasoning"] }).success).toBe(false);
  expect(sessionActivityArgsSchema.safeParse({ sessionId: "ses_fixture", since: "invalid" }).success).toBe(false);
  expect(activity?.arguments.map((argument) => argument.name).sort()).toEqual(Object.keys(sessionActivityArgsSchema.shape).sort());
  expect(activity).toMatchObject({ kind: "query", effects: { data: "read", ui: "none", external: false }, executor: { kind: "openwork" } });
  for (const value of ["300", "byAffordanceId", "ok: false", "callId", "not capped"]) expect(activity?.description).toContain(value);
  evidence.recordAssertionEvidence("Tool opt-in and activity contracts are discoverable", "Descriptors match accepted enum values and text defaults, advertise redaction and field caps, reject unsupported scopes and invalid timestamps, and declare activity read-only.", true);
});

test("HTTP transcript fixture preserves the prior reply and counts three session.create calls with one too_big outcome", async ({ evidence }) => {
  const original = { url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
  const session = { id: "ses_fixture", title: "Synthetic transcript", directory: "/tmp/session-tool-parts-fixture", time: { created: 100, updated: 400 } };
  const needle = "input-only-fixture-needle";
  const failure = "too_big: prompt exceeds 100000 characters";
  const tools = [1, 2, 3].map((index) => ({
    type: "tool", tool: "openwork_execute", callID: `call_${index}`,
    state: {
      status: "completed", input: { id: "session.create", sessions: [{ title: `Fixture ${index}`, prompt: index === 1 ? needle : "Synthetic task" }] },
      output: JSON.stringify(index === 3 ? { ok: true, result: { ok: false, error: failure } } : { ok: true }),
      time: { start: 300 + index * 10, end: 301 + index * 10 },
    },
  }));
  const reply = "The investigation is complete.";
  const preTool = "I will now create the follow-up tasks.";
  const messages = [
    { info: { id: "msg_user", role: "user", time: { created: 100 } }, parts: [{ type: "text", text: "Investigate this synthetic issue." }] },
    { info: { id: "msg_reply", role: "assistant", time: { created: 200 } }, parts: [{ type: "text", text: reply }] },
    { info: { id: "msg_pretool", role: "assistant", time: { created: 300 } }, parts: [{ type: "step-start" }, { type: "text", text: preTool }, ...tools, { type: "step-finish" }] },
  ];
  const base = "/workspace/ws/opencode";
  const requests: string[] = [];
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.headers.authorization !== "Bearer transcript-fixture-token") return json(401, { error: "Unauthorized" });
    if (request.method !== "GET") return json(405, { error: "Read-only fixture" });
    if (url.pathname === "/workspaces") return json(200, { items: [{ id: "ws", name: "Fixture", path: session.directory }] });
    if (url.pathname === `${base}/session`) return json(200, [session]);
    if (url.pathname === `${base}/session/ses_fixture`) return json(200, session);
    if (url.pathname === `${base}/session/ses_fixture/message`) {
      const limit = url.searchParams.get("limit");
      return json(200, limit === null ? messages : messages.slice(-Number(limit)));
    }
    if (url.pathname === `${base}/session/status`) return json(200, {});
    if ([`${base}/session/ses_fixture/children`, `${base}/permission`, `${base}/question`].includes(url.pathname)) return json(200, []);
    unexpected.push(url.pathname);
    return json(404, { error: "Unknown fixture route" });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Transcript fixture did not bind a port");
    process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPENWORK_SERVER_TOKEN = "transcript-fixture-token";
    const plugin = await OpenWorkExtensionsPreview();
    const query = async (id: string, args: Record<string, unknown>) => {
      const output = record(JSON.parse(await plugin.tool.openwork_query.execute({ id, args: { workspaceId: "ws", ...args } })));
      expect(output).toMatchObject({ ok: true, id });
      const result = record(output.result);
      expect(result.ok).toBe(true);
      return result;
    };
    const normal = await query("session.read", { sessionId: session.id });
    expect(records(normal.messages).at(-1)).toMatchObject({ id: "msg_pretool", text: preTool });
    for (const parts of [["text"], ["text", "tool"]]) {
      const summary = await query("session.read", { sessionId: session.id, summary: true, parts });
      expect(summary.lastAssistant).toMatchObject({ id: "msg_reply", text: reply });
      expect(record(summary.lastAssistant).text).not.toBe(preTool);
    }
    evidence.recordAssertionEvidence("HTTP fixture summary prefers the prior reply over trailing sole pre-tool text", "The production session.read adapter read a synthetic HTTP transcript: normal read retained the trailing pre-tool text, while text-only and text+tool summaries selected msg_reply instead of msg_pretool. No inference or real session creation is claimed.", true);
    const toolRead = await query("session.read", { sessionId: session.id, parts: ["tool"] });
    const readTools = records(toolRead.messages).flatMap((message) => records(message.tools));
    expect(readTools.map((tool) => tool.callId)).toEqual(["call_1", "call_2", "call_3"]);
    expect(text(readTools[0]?.input)).toContain(needle);
    expect(JSON.stringify(normal)).not.toContain(needle);
    expect((await query("session.search", { query: needle })).results).toEqual([]);
    const searched = await query("session.search", { query: needle, in: ["tool"] });
    expect(records(searched.results)).toHaveLength(1);
    expect(records(searched.results)[0]).toMatchObject({ sessionId: session.id, kind: "tool", tool: "openwork_execute", callId: "call_1", snippet: { match: needle } });
    const activity = await query("session.activity", { sessionId: session.id });
    expect(activity.toolCalls).toEqual({ total: 3, byTool: { openwork_execute: 3 }, byAffordanceId: { "session.create": 3 } });
    expect(activity.errors).toEqual({ total: 1, list: [{ callId: "call_3", tool: "openwork_execute", affordanceId: "session.create", message: failure, at: 331 }] });
    expect(activity.messages).toEqual({ user: 1, assistant: 2 });
    expect(unexpected).toEqual([]);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(requests).toContain(`GET ${base}/session/ses_fixture/message`);
    evidence.recordAssertionEvidence("HTTP fixture tool search and activity expose three calls and one failed outcome", "Synthetic tool input was hidden by default read/search and found by tool-only search. Production activity grouped three openwork_execute calls under session.create and counted only call_3's nested ok:false too_big outcome; both successful calls were excluded from errors. All witness requests were read-only and used declared routes.", true);
  } finally {
    if (original.url === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = original.url;
    if (original.token === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = original.token;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("session.read and session.activity expose a real isolated headless shell call without leaking tool data by default", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun"] });
  if (place.kind !== "local") throw new SkipError("local manifest proof; Daytona requires a remote runtime manifest adapter");
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "session-tool-parts-")));
  const original = { url: process.env.OPENWORK_SERVER_URL, token: process.env.OPENWORK_SERVER_TOKEN };
  try {
    await using app = await appWeb({ name: "session-tool-parts", workspacePath: scratch, place });
    const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const runtime = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (!runtime || runtime.openworkUrl !== app.openworkUrl || runtime.workspace !== scratch) throw new Error("Could not identify the test-owned headless runtime");
    process.env.OPENWORK_SERVER_URL = runtime.openworkUrl;
    process.env.OPENWORK_SERVER_TOKEN = runtime.token;
    const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<unknown> => {
      const response = await fetch(`${runtime.openworkUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Isolated engine request ${path} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return response.status === 204 ? null : response.json();
    };
    const workspace = records(record(await request("/workspaces")).items).find((entry) => entry.path === scratch);
    if (!workspace) throw new Error("Isolated workspace not found");
    const workspaceId = text(workspace.id);
    const base = `/workspace/${encodeURIComponent(workspaceId)}/opencode/session`;
    const model = { providerID: "tool-parts-unconfigured", modelID: "unused" };
    const sessionId = text(record(await request(base, { title: "Tool execution witness" })).id);
    const outputMarker = "witness-output-only-7c93";
    const neighborId = text(record(await request(base, { title: outputMarker })).id);
    const firstUser = "Keep this user message in the default transcript.";
    await request(`${base}/${sessionId}/message`, { noReply: true, model, parts: [{ type: "text", text: firstUser }] });
    await request(`${base}/${neighborId}/message`, { noReply: true, model, parts: [{ type: "text", text: outputMarker }] });
    const plugin = await OpenWorkExtensionsPreview({ directory: scratch });
    const query = async (id: string, args: Record<string, unknown>) => {
      const output = record(JSON.parse(await plugin.tool.openwork_query.execute({ id, args: { workspaceId, ...args } })));
      expect(output.ok).toBe(true);
      const result = record(output.result);
      expect(result.ok).toBe(true);
      return result;
    };
    const before = await query("session.activity", { sessionId });
    expect(before.toolCalls).toEqual({ total: 0, byTool: {}, byAffordanceId: {} });
    const source = `process.stdout.write(JSON.stringify({ok:false,error:"intentional failure token=fixture-secret " + "E".repeat(400),payload:"P".repeat(2400)+["witness","output","only","7c93"].join("-")}))`;
    const command = `${JSON.stringify(process.execPath)} -e '${source}'`;
    expect(command).not.toContain(outputMarker);
    const shell = record(await request(`${base}/${sessionId}/shell`, { agent: "build", model, command }));
    const actualTool = records(shell.parts).find((part) => part.type === "tool");
    if (!actualTool) throw new Error("Real engine shell did not persist a tool part");
    const actualState = record(actualTool.state);
    expect(actualState.status).toBe("completed");
    expect(actualTool.tool).toBe("bash");
    expect(actualState.input).toMatchObject({ command });
    expect(text(actualState.output)).toContain(outputMarker);
    expect(text(actualState.output)).toContain("fixture-secret");
    const callId = text(actualTool.callID);
    const toolRead = await eventually(() => query("session.read", { sessionId, parts: ["tool"], from: "start" }), {
      within: 15_000, intervalMs: 250, label: "persisted real shell call visible through session.read",
      until: (result) => records(result.messages).some((message) => records(message.tools).some((tool) => tool.callId === callId)),
    });
    const tools = records(toolRead.messages).flatMap((message) => records(message.tools));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "tool", tool: "bash", callId, status: "completed", truncated: true });
    expect(text(tools[0]?.output)).toHaveLength(2000);
    expect(text(tools[0]?.output)).not.toContain(outputMarker);
    for (const field of ["input", "output", "error"]) expect(text(tools[0]?.[field]).length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(toolRead)).toContain("[redacted]");
    expect(JSON.stringify(toolRead)).not.toContain("fixture-secret");
    expect(records(toolRead.messages).every((message) => message.text === "")).toBe(true);
    const defaultRead = await query("session.read", { sessionId, from: "start" });
    expect(records(defaultRead.messages).some((message) => message.text === firstUser)).toBe(true);
    expect(records(defaultRead.messages).every((message) => message.tools === undefined && message.reasoning === undefined)).toBe(true);
    expect(JSON.stringify(defaultRead)).not.toContain(outputMarker);
    const summary = await query("session.read", { sessionId, summary: true, parts: ["text", "tool"] });
    expect(record(summary.firstUser).text).toBe(firstUser);
    expect(summary.lastAssistant).toBeNull();
    const toolSearch = await query("session.search", { query: outputMarker, in: ["tool"], match: "phrase" });
    expect(records(toolSearch.results).map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(records(toolSearch.results)[0]).toMatchObject({ kind: "tool", tool: "bash", callId, status: "completed" });
    expect(JSON.stringify(toolSearch)).not.toContain("fixture-secret");
    const defaultSearch = await query("session.search", { query: outputMarker, match: "phrase" });
    expect(records(defaultSearch.results).map((entry) => entry.sessionId)).toEqual([neighborId]);
    const secretSearch = await query("session.search", { query: "fixture-secret", in: ["tool"] });
    expect(secretSearch.results).toEqual([]);
    evidence.recordAssertionEvidence("Real shell tool opt-in, default isolation, full-field search and redaction", "The engine persisted exactly one completed bash call; session.read returned the same call ID with redacted fields capped at 2000 characters. Tool search found an output-only marker beyond the read cap, excluded the text/title neighbor and could not find the secret. Default read/search excluded tool data; a tool-only assistant did not become the summary reply.", true);
    const activity = await query("session.activity", { sessionId });
    expect(activity.toolCalls).toEqual({ total: 1, byTool: { bash: 1 }, byAffordanceId: {} });
    const errors = record(activity.errors);
    expect(errors.total).toBe(1);
    const failures = records(errors.list);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ callId, tool: "bash" });
    expect(text(failures[0]?.message)).toHaveLength(300);
    expect(text(failures[0]?.message)).toContain("token=[redacted]");
    expect(JSON.stringify(activity)).not.toContain("fixture-secret");
    expect(activity.firstAt).toBeTypeOf("number");
    expect(activity.lastAt).toBeTypeOf("number");
    expect(activity.messages).toMatchObject({ assistant: 1 });
    const inclusive = await query("session.activity", { sessionId, since: failures[0]?.at });
    expect(record(inclusive.toolCalls).total).toBe(1);
    if (typeof activity.lastAt !== "number") throw new Error("Expected dated real engine activity");
    const future = await query("session.activity", { sessionId, since: activity.lastAt + 1 });
    expect(future).toMatchObject({ toolCalls: { total: 0, byTool: {}, byAffordanceId: {} }, errors: { total: 0, list: [] }, messages: { user: 0, assistant: 0 }, firstAt: null, lastAt: null });
    const neighbor = await query("session.activity", { sessionId: neighborId });
    expect(neighbor.toolCalls).toEqual({ total: 0, byTool: {}, byAffordanceId: {} });
    expect(neighbor.errors).toEqual({ total: 0, list: [] });
    evidence.recordAssertionEvidence("Activity counts the real call and its failed JSON outcome exactly once", "Activity changed from zero to one bash call and one completed ok:false outcome with the same call ID. Error text was redacted before its 300-character cap. Inclusive since preserved the call, future since returned honest zeros, and the neighbor retained zero tool calls/errors.", true);
    const context = record(JSON.parse(await plugin.tool.openwork_context.execute()));
    const listing = records(record(context.context).availableAffordances).find((entry) => entry.id === "session.list_sessions");
    if (!listing) throw new Error("Isolated app did not advertise session.list_sessions");
    const archiveArgument = records(listing.arguments).find((argument) => argument.name === "archived");
    expect(archiveArgument).toMatchObject({ type: "string", required: false });
    for (const mode of ["include (default)", "exclude", "only"]) expect(text(archiveArgument?.description)).toContain(mode);
    expect(text(listing.description)).toContain("`archived`");
    const listApp = async (archived?: string) => {
      const output = record(JSON.parse(await plugin.tool.openwork_query.execute({
        id: "session.list_sessions", args: { workspaceId, ...(archived === undefined ? {} : { archived }) },
      })));
      expect(output.ok).toBe(true);
      return records(output.result);
    };
    const bothIds = [sessionId, neighborId].sort();
    const initial = await eventually(() => listApp(), {
      within: 15_000, intervalMs: 250, label: "both real sessions loaded by the isolated app inventory",
      until: (entries) => bothIds.every((id) => entries.some((entry) => entry.sessionId === id && entry.archived === false)),
    });
    expect(initial.map((entry) => entry.sessionId).sort()).toEqual(bothIds);
    for (const archived of [1700000000000, 0]) {
      const updated = record(await request(`${base}/${neighborId}`, { time: { archived } }, "PATCH"));
      expect(record(updated.time).archived).toBe(archived);
      const isArchived = archived > 0;
      const loaded = await eventually(() => listApp("include"), {
        within: 15_000, intervalMs: 250, label: `app inventory observes archive timestamp ${archived}`,
        until: (entries) => entries.some((entry) => entry.sessionId === neighborId && entry.archived === isArchived),
      });
      expect(loaded.map((entry) => entry.sessionId).sort()).toEqual(bothIds);
      expect(loaded.find((entry) => entry.sessionId === sessionId)?.archived).toBe(false);
      expect((await listApp()).map((entry) => ({ id: entry.sessionId, archived: entry.archived }))).toEqual(loaded.map((entry) => ({ id: entry.sessionId, archived: entry.archived })));
      const excluded = await listApp("exclude");
      expect(excluded.map((entry) => entry.sessionId).sort()).toEqual(isArchived ? [sessionId] : bothIds);
      expect(excluded.every((entry) => entry.archived === false)).toBe(true);
      const only = await listApp("only");
      expect(only.map((entry) => entry.sessionId)).toEqual(isArchived ? [neighborId] : []);
      expect(only.every((entry) => entry.archived === true)).toBe(true);
    }
    evidence.recordAssertionEvidence("The real app advertises and applies archive inventory filters, including restored timestamp zero", "Through the isolated plugin bridge, session.list_sessions advertised the archived argument and include/exclude/only modes. Native engine PATCH persisted 1700000000000 then 0; bounded polling observed archived=true then false in the app inventory. Default matched include, exclude removed only the archived neighbor, only returned that neighbor while archived and became empty after restore; the untouched session stayed unarchived.", true);
  } finally {
    if (original.url === undefined) delete process.env.OPENWORK_SERVER_URL;
    else process.env.OPENWORK_SERVER_URL = original.url;
    if (original.token === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
    else process.env.OPENWORK_SERVER_TOKEN = original.token;
    await rm(scratch, { recursive: true, force: true });
  }
});
