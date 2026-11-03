import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { bootDen, type Session, type Method } from "./harness.js"

const den = await bootDen()
after(() => den.close())

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
const id = (prefix: string) => `${prefix}_0${randomBytes(16).toString("hex").slice(0, 25)}`;

async function capturingLogs<T>(run: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const chunks: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  const stderr = process.stderr.write.bind(process.stderr)
  const capture = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }
  process.stdout.write = capture
  process.stderr.write = capture
  try {
    return { value: await run(), logs: chunks.join("") }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}
test("Library workflow cards preserve readable history windows without per-workflow queries", async () => {
  const { orgId, owner: ownerSession } = await den.createOrg(await den.signUp("Report owner"), "Workflow history regression")
  const teammateSession = await den.newMember(ownerSession, orgId, "Report teammate")
  const api = (person: Session, path: string, init: { method?: Method; body?: string } = {}) => den.as(person, orgId)(init.method ?? "GET", path, init.body ? JSON.parse(init.body) : undefined)
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("This regression needs MySQL")
  const query = async (statement: string, values: string[] = []) => {
    const [rows] = await client.execute(statement, values)
    return Array.isArray(rows) ? rows : []
  }
  const plugin = await api(ownerSession, "/v1/plugins", { method: "POST", body: JSON.stringify({ name: "Shared reports", orgWide: true }) });
  assert.equal(plugin.status, 201, JSON.stringify(plugin.body));
  const pluginId = text(record(record(plugin.body).item).id);
  const created = await api(ownerSession, "/v1/config-objects", { method: "POST", body: JSON.stringify({
    type: "workflow", sourceMode: "cloud", pluginIds: [pluginId], input: {
      rawSourceText: "return { report: true };", schemaVersion: "codemode-script-v1",
      normalizedPayloadJson: { language: "codemode-js", requiredCapabilities: [] },
    },
  }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const template = text(record(record(created.body).item).id);
  const [source] = (await query("SELECT organization_id, created_by_org_membership_id FROM config_object WHERE id = ?", [template])).map(record);
  if (!source) throw new Error("Missing fixture owner");
  const org = text(source.organization_id), owner = text(source.created_by_org_membership_id);
  const [other] = (await query("SELECT id FROM member WHERE organization_id = ? AND id <> ? LIMIT 1", [org, owner])).map(record);
  if (!other) throw new Error("Missing teammate");
  const teammate = text(other.id);
  const workflows = Array.from({ length: 103 }, (_, n) => ({ id: id("cob"), version: id("cov"), membership: id("pco"), name: `Report ${n}` }));
  const fixture = JSON.stringify(workflows);
  const jsonRows = "JSON_TABLE(?, '$[*]' COLUMNS (id VARCHAR(64) PATH '$.id', version VARCHAR(64) PATH '$.version', membership VARCHAR(64) PATH '$.membership', name VARCHAR(255) PATH '$.name')) AS fixture";
  await query(`INSERT INTO config_object (id, organization_id, object_type, source_mode, title, created_by_org_membership_id) SELECT fixture.id, ?, 'workflow', 'cloud', fixture.name, ? FROM ${jsonRows}`, [org, owner, fixture]);
  await query(`INSERT INTO config_object_version (id, organization_id, config_object_id, normalized_payload_json, raw_source_text, schema_version, created_via, created_by_org_membership_id) SELECT fixture.version, source.organization_id, fixture.id, source.normalized_payload_json, source.raw_source_text, source.schema_version, 'cloud', ? FROM config_object_version AS source JOIN ${jsonRows} WHERE source.config_object_id = ?`, [owner, fixture, template]);
  await query(`INSERT INTO plugin_config_object (id, organization_id, plugin_id, config_object_id, membership_source, created_by_org_membership_id) SELECT fixture.membership, ?, ?, fixture.id, 'manual', ? FROM ${jsonRows}`, [org, pluginId, owner, fixture]);
  const now = Date.now();
  const receipts: Array<Record<string, string | null>> = [];
  const receipt = (n: number, age: number, options: Record<string, string | null> = {}) => {
    const workflow = workflows[n];
    if (!workflow) throw new Error("Missing fixture workflow");
    receipts.push({ id: id("wfr"), org, member: owner, plugin: pluginId, workflow: workflow.id, version: workflow.version,
      source: "private", status: "succeeded", finished: new Date(now - age * 1000).toISOString().slice(0, 23).replace("T", " "), deleted: null, ...options });
  };
  for (let n = 0; n < workflows.length; n++) receipt(n, 200);
  // The successful 101st receipt is outside the same history window as detail.
  for (let n = 0; n < 100; n++) receipt(0, n, { status: "failed" });
  receipt(1, 0, { member: teammate, status: "failed" });
  receipt(2, 0, { member: teammate, source: `plugin:${pluginId}:${workflows[2]!.id}` });
  for (let n = 0; n < 100; n++) receipt(3, n, { plugin: null });
  receipt(4, 0, { deleted: new Date(now).toISOString().slice(0, 23).replace("T", " ") });
  receipt(5, 0, { version: null, status: "failed" });
  for (let offset = 0; offset < receipts.length; offset += 100) {
    await query(`INSERT INTO workflow_run (id, organization_id, org_membership_id, plugin_id, config_object_id, config_object_version_id, source, code_digest, status, finished_at, started_at, artifact_content_deleted_at, result_markdown) SELECT id, org, member, plugin, workflow, version, source, 'fixture', status, finished, finished, deleted, 'unreadable ciphertext must not be decoded for a card' FROM JSON_TABLE(?, '$[*]' COLUMNS (id VARCHAR(64) PATH '$.id', org VARCHAR(64) PATH '$.org', member VARCHAR(64) PATH '$.member', plugin VARCHAR(64) PATH '$.plugin', workflow VARCHAR(64) PATH '$.workflow', version VARCHAR(64) PATH '$.version', source VARCHAR(255) PATH '$.source', status VARCHAR(20) PATH '$.status', finished DATETIME(3) PATH '$.finished', deleted DATETIME(3) PATH '$.deleted')) AS fixture`, [JSON.stringify(receipts.slice(offset, offset + 100))]);
  }
  const library = async (session: Session) => {
    const result = await api(session, "/v1/me/library");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const items = record(result.body).items;
    if (!Array.isArray(items)) throw new Error("Missing Library items");
    return new Map(items.map(record).filter(item => item.type === "workflow").map(item => [text(item.id), item]));
  };
  const { value: cards, logs: accessLogs } = await capturingLogs(() => library(ownerSession));
  assert.equal(cards.size, 104);
  assert.equal(cards.get(workflows[0]!.id)?.latestSuccessfulAt, null);
  assert.equal(cards.get(workflows[0]!.id)?.resultState, "needs_attention");
  assert.equal(cards.get(workflows[3]!.id)?.resultState, "never_run");
  for (const n of [1, 2, 4, 5, 102]) assert.equal(cards.get(workflows[n]!.id)?.resultState, "fresh");
  const logs = accessLogs.split("\n").flatMap(line => { try { return [record(JSON.parse(line))]; } catch { return []; } });
  const request = logs.findLast(line => line.http_route === "/v1/me/library" && typeof line.db_queries === "number");
  assert.ok(request, "Library access log records the query count");
  assert.ok(Number(request?.db_queries) < 80, `Library used ${String(request?.db_queries)} queries`);
  const teammateCards = await library(teammateSession);
  assert.equal(teammateCards.get(workflows[1]!.id)?.resultState, "needs_attention");
  assert.equal(teammateCards.get(workflows[2]!.id)?.resultState, "fresh");
  assert.equal(teammateCards.get(workflows[102]!.id)?.resultState, "never_run");
})
