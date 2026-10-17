import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

/**
 * The demo Atlassian server is a stand-in for an enterprise's self-hosted Jira and Confluence Data Center plus the
 * community mcp-atlassian server in front of them. These checks pin the behaviour demos and workshops rely on, and
 * (opt-in, needs `uvx` and network) prove the built-in MCP answers exactly like the real mcp-atlassian does when
 * pointed at this server's REST API.
 */

const SCRIPT = fileURLToPath(new URL("./demo-atlassian.mjs", import.meta.url));
let child: ChildProcess;
let base = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port) }, stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await fetch(`${base}/health`).then((response) => response.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("demo-atlassian did not start");
});
afterAll(() => { child?.kill(); });
beforeEach(async () => { await fetch(`${base}/reset`, { method: "POST" }); });

let rpcId = 0;
async function mcp(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return response.json();
}
async function tool(name: string, args: Record<string, unknown>) {
  const body = await mcp("tools/call", { name, arguments: args });
  const text: string = body.result.content[0].text;
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* error text */ }
  return { isError: body.result.isError === true, text, value };
}
async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { authorization: "Bearer demo-pat", "content-type": "application/json", ...init.headers } });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

describe("MCP surface (mcp-atlassian with FastMCP 3.4.9)", () => {
  test("offers the mcp-atlassian Jira, Service Management and Confluence tools", async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result.serverInfo).toEqual({ name: "Atlassian MCP", version: "3.4.9" });
    const names = (await mcp("tools/list")).result.tools.map((entry: { name: string }) => entry.name);
    expect(names).toHaveLength(28);
    expect(names).toEqual(expect.arrayContaining(["jira_search", "jira_create_issue", "jira_create_customer_request", "confluence_search", "confluence_get_page", "confluence_create_page"]));
  });

  test("creates a documentation ticket assigned to a teammate by name", async () => {
    const created = await tool("jira_create_issue", { project_key: "DOC", summary: "Update documentation for the project XYZ", issue_type: "Task", assignee: "Nora Patel" });
    expect(created.isError).toBe(false);
    const { issue } = created.value as { issue: { key: string; assignee: { display_name: string } } };
    expect(issue.assignee.display_name).toBe("Nora Patel");
    const found = await tool("jira_search", { jql: `key = ${issue.key} AND assignee = "nora@acme.test"` });
    expect((found.value as { total: number }).total).toBe(1);
  });

  test("raises a password reset through the IT service desk", async () => {
    const fields = await tool("jira_get_request_type_fields", { service_desk_id: "1", request_type_id: "11" });
    expect((fields.value as { fields: { field_id: string; required: boolean }[] }).fields.filter((field) => field.required).map((field) => field.field_id)).toEqual(["summary", "customfield_10500"]);
    const missing = await tool("jira_create_customer_request", { service_desk_id: "1", request_type_id: "11", request_field_values: JSON.stringify({ summary: "Forgot my password" }) });
    expect(missing.text).toContain("JSM_CUSTOMER_REQUEST_MISSING_REQUIRED_FIELDS");
    const created = await tool("jira_create_customer_request", { service_desk_id: "1", request_type_id: "11", request_field_values: JSON.stringify({ summary: "Forgot my password", customfield_10500: { value: "Windows login" } }) });
    const key = (created.value as { request_key: string }).request_key;
    expect(key).toMatch(/^ITSD-\d+$/);
    const issue = await tool("jira_get_issue", { issue_key: key, fields: "summary,status,issuetype" });
    expect(issue.value).toMatchObject({ summary: "Forgot my password", status: { name: "Waiting for support" }, issue_type: { name: "Service Request" } });
  });

  test("finds what the handbook says and nothing it does not", async () => {
    const password = await tool("confluence_search", { query: "password reset", spaces_filter: "HB" });
    expect((password.value as { title: string }[]).map((page) => page.title)).toContain("IT and security");
    const dogs = await tool("confluence_search", { query: "dog office policy" });
    expect(dogs.value).toEqual([]);
  });

  test("answers bad arguments and missing things the way mcp-atlassian does", async () => {
    expect((await tool("jira_get_issue", { issue_key: "bad key" })).text).toMatch(/^1 validation error for call\[get_issue\]\nissue_key\n {2}String should match pattern/);
    expect((await tool("jira_get_issue", { issue_key: "DOC-999" })).text).toBe("Error calling tool 'get_issue': Issue DOC-999 not found. Verify the issue key and project access.");
    expect((await tool("confluence_get_page", { page_id: "1" })).value).toEqual({ error: expect.stringContaining("Failed to retrieve page by ID '1'") });
  });
});

describe("REST API (Data Center shapes)", () => {
  test("requires a token like Data Center does", async () => {
    const response = await fetch(`${base}/jira/rest/api/2/myself`);
    expect(response.status).toBe(401);
  });

  test("runs JQL with functions, relative dates and ordering", async () => {
    const result = await rest(`/jira/rest/api/2/search?jql=${encodeURIComponent("project = FLEET AND labels = launch-blocker AND resolution = Unresolved ORDER BY key ASC")}&fields=summary`);
    expect(result.body.issues.map((issue: { key: string }) => issue.key)).toEqual(["FLEET-342", "FLEET-351"]);
    const bad = await rest(`/jira/rest/api/2/search?jql=${encodeURIComponent("bogus = 1")}`);
    expect(bad.status).toBe(400);
    expect(bad.body.errorMessages[0]).toContain("Field 'bogus' does not exist");
  });

  test("rejects a Confluence update that skips a version", async () => {
    const page = await rest("/confluence/rest/api/content?spaceKey=HB&title=IT%20and%20security&expand=version");
    const { id, version } = page.body.results[0];
    const stale = await rest(`/confluence/rest/api/content/${id}`, { method: "PUT", body: JSON.stringify({ type: "page", title: "IT and security", version: { number: version.number }, body: { storage: { value: "<p>x</p>", representation: "storage" } } }) });
    expect(stale.status).toBe(409);
    const saved = await rest(`/confluence/rest/api/content/${id}`, { method: "PUT", body: JSON.stringify({ type: "page", title: "IT and security", version: { number: version.number + 1 }, body: { storage: { value: "<p>x</p>", representation: "storage" } } }) });
    expect(saved.status).toBe(200);
    expect(saved.body.version.number).toBe(version.number + 1);
  });

  test("keeps writes in memory until reset", async () => {
    await tool("jira_add_comment", { issue_key: "DOC-41", body: "Looks good" });
    expect((await rest("/jira/rest/api/2/issue/DOC-41/comment")).body.total).toBe(1);
    await fetch(`${base}/reset`, { method: "POST" });
    expect((await rest("/jira/rest/api/2/issue/DOC-41/comment")).body.total).toBe(0);
  });
});

/**
 * Opt-in: DEMO_ATLASSIAN_PARITY=1 runs the real mcp-atlassian (via uvx) against this server's REST API and checks
 * that the built-in MCP returns the same text for the same calls (URLs and timestamps normalized).
 */
const parity = process.env.DEMO_ATLASSIAN_PARITY === "1" && spawnSync("uvx", ["--version"]).status === 0;
describe.skipIf(!parity)("parity with the real mcp-atlassian", () => {
  const CALLS: [string, Record<string, unknown>][] = [
    ["jira_get_all_projects", {}],
    ["jira_search", { jql: "project = FLEET AND labels = launch-blocker ORDER BY priority ASC", limit: 5 }],
    ["jira_get_issue", { issue_key: "FLEET-342", include: "all", comment_limit: 1 }],
    ["jira_get_request_type_fields", { service_desk_id: "1", request_type_id: "11" }],
    ["jira_create_issue", { project_key: "DOC", summary: "Update documentation for the project XYZ", issue_type: "Task", assignee: "Nora Patel", description: "Refresh:\n\n- manual\n- addendum" }],
    ["jira_transition_issue", { issue_key: "DOC-45", transition_id: "21" }],
    ["jira_create_customer_request", { service_desk_id: "1", request_type_id: "11", request_field_values: "{\"summary\": \"Password reset\"}" }],
    ["confluence_search", { query: "Blue Harbor churn", limit: 3 }],
    ["confluence_get_page", { title: "Atlas Lift pallet robot – datasheet", space_key: "PROD" }],
    ["confluence_create_page", { space_key: "PROD", title: "Draft", content: "# Draft\n\n- one" }],
    ["confluence_get_page", { page_id: "999" }],
    ["jira_get_issue", { issue_key: "bad key" }],
  ];
  const normalize = (text: string) => text
    .replace(/https?:\/\/127\.0\.0\.1:\d+\/jira|https:\/\/jira\.acme\.test/g, "<JIRA>")
    .replace(/https?:\/\/127\.0\.0\.1:\d+\/confluence|https:\/\/confluence\.acme\.test/g, "<CONFLUENCE>")
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}| [A-Z]{3,4})?/g, "<TIME>");

  async function realResults(): Promise<string[]> {
    // 3.4.9 in serverInfo is FastMCP's version, not the mcp-atlassian distribution version.
    const real = spawn("uvx", ["--from", "mcp-atlassian==0.23.1", "--with", "fastmcp==3.4.9", "mcp-atlassian"], { env: { ...process.env, JIRA_URL: `${base}/jira`, JIRA_PERSONAL_TOKEN: "demo-pat", CONFLUENCE_URL: `${base}/confluence`, CONFLUENCE_PERSONAL_TOKEN: "demo-pat" }, stdio: ["pipe", "pipe", "ignore"] });
    type RpcReply = { result: { content: { text: string }[] } };
    let buffer = "";
    const waiting = new Map<number, { resolve: (value: RpcReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const failPending = (error: Error) => { for (const call of waiting.values()) { clearTimeout(call.timer); call.reject(error); } waiting.clear(); };
    real.on("error", () => failPending(new Error("Could not launch real mcp-atlassian parity server.")));
    real.on("exit", (code) => failPending(new Error(`Real mcp-atlassian parity server exited (${code}).`)));
    real.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const message = JSON.parse(line); const call = waiting.get(message.id); if (call) { clearTimeout(call.timer); waiting.delete(message.id); call.resolve(message); } } catch { /* log line */ }
      }
    });
    const request = (id: number, method: string, params: unknown) => new Promise<RpcReply>((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); real.kill(); reject(new Error(`Real mcp-atlassian ${method} timed out.`)); }, 90_000);
      waiting.set(id, { resolve, reject, timer });
      real.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    try {
      await request(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity", version: "1" } });
      real.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const texts: string[] = [];
      for (const [index, [name, args]] of CALLS.entries()) texts.push((await request(index + 1, "tools/call", { name, arguments: args })).result.content[0].text);
      return texts;
    } finally { real.kill(); }
  }

  test("same answers for the same calls", async () => {
    await fetch(`${base}/reset`, { method: "POST" });
    const real = await realResults();
    await fetch(`${base}/reset`, { method: "POST" });
    const native: string[] = [];
    for (const [name, args] of CALLS) native.push((await tool(name, args)).text);
    expect(native.map(normalize)).toEqual(real.map(normalize));
  }, 300_000);
});
