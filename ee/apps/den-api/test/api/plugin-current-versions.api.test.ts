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
const id = (prefix: string, high = false) => `${prefix}_${high ? "1" : "0"}${randomBytes(16).toString("hex").slice(0, 25)}`;
const markdown = (revision: string) => `---\nname: current-version-check\ndescription: Verify immutable skill revisions.\n---\n\n${revision}`;

test("plugin resolution keeps current versions, deletion markers and private access across batches", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Revision owner"), "Revision regression")
  const outsider = await den.newMember(owner, orgId, "Other member")
  const api = (person: Session, path: string, init: { method?: Method; body?: string } = {}) => den.as(person, orgId)(init.method ?? "GET", path, init.body ? JSON.parse(init.body) : undefined)
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("This regression needs MySQL")
  const query = async (statement: string, values: string[] = []) => {
    const [rows] = await client.execute(statement, values)
    return Array.isArray(rows) ? rows : []
  }
  const pluginResult = await api(owner, "/v1/plugins", { method: "POST", body: JSON.stringify({ name: "Private revision checks" }) });
  assert.equal(pluginResult.status, 201, JSON.stringify(pluginResult.body));
  const pluginId = text(record(record(pluginResult.body).item).id);
  const created = await api(owner, "/v1/config-objects", { method: "POST", body: JSON.stringify({ type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: markdown("Older instructions") } }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const templateItem = record(record(created.body).item);
  const template = text(templateItem.id), oldVersion = text(record(templateItem.latestVersion).id);
  const revised = await api(owner, `/v1/config-objects/${template}/versions`, { method: "POST", body: JSON.stringify({ input: { rawSourceText: markdown("Current instructions") }, reason: "Exercise immutable version selection" }) });
  assert.equal(revised.status, 201, JSON.stringify(revised.body));
  const versionRows = (await query("SELECT id FROM config_object_version WHERE config_object_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [template])).map(record);
  const currentVersion = text(versionRows[0]?.id);
  const objects = Array.from({ length: 103 }, (_, n) => ({ id: id("cob"), version: id("cov", true), old: id("cov"), membership: id("pco"), name: `Revision check ${n}` }));
  const fixture = JSON.stringify(objects);
  const jsonRows = "JSON_TABLE(?, '$[*]' COLUMNS (id VARCHAR(64) PATH '$.id', version VARCHAR(64) PATH '$.version', old VARCHAR(64) PATH '$.old', membership VARCHAR(64) PATH '$.membership', name VARCHAR(255) PATH '$.name')) AS fixture";
  await query(`INSERT INTO config_object (id, organization_id, object_type, source_mode, title, created_by_org_membership_id) SELECT fixture.id, source.organization_id, 'skill', 'cloud', fixture.name, source.created_by_org_membership_id FROM config_object AS source JOIN ${jsonRows} WHERE source.id = ?`, [fixture, template]);
  for (const [field, sourceVersion] of [["old", oldVersion], ["version", currentVersion]]) {
    await query(`INSERT INTO config_object_version (id, organization_id, config_object_id, normalized_payload_json, raw_source_text, schema_version, created_via, created_by_org_membership_id, created_at) SELECT fixture.${field}, source.organization_id, fixture.id, source.normalized_payload_json, source.raw_source_text, source.schema_version, 'cloud', source.created_by_org_membership_id, '2026-01-01 00:00:00.000' FROM config_object_version AS source JOIN ${jsonRows} WHERE source.id = ?`, [fixture, sourceVersion]);
  }
  await query(`INSERT INTO plugin_config_object (id, organization_id, plugin_id, config_object_id, membership_source, created_by_org_membership_id) SELECT fixture.membership, source.organization_id, source.plugin_id, fixture.id, 'manual', source.created_by_org_membership_id FROM plugin_config_object AS source JOIN ${jsonRows} WHERE source.config_object_id = ? AND source.plugin_id = ?`, [fixture, template, pluginId]);
  // Both timestamp ties and the deleted-version marker must keep their meaning.
  await query("UPDATE config_object_version SET is_deleted_version = TRUE WHERE id = ?", [objects[0]!.version]);
  // The old loader decoded this discarded revision and failed the whole read.
  await query("UPDATE config_object_version SET normalized_payload_json = 'unreadable historical ciphertext', created_at = '2000-01-01 00:00:00' WHERE id = ?", [oldVersion]);
  const resolved = await api(owner, `/v1/plugins/${pluginId}/resolved`);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const items = record(resolved.body).items;
  if (!Array.isArray(items)) throw new Error("Missing resolved plugin contents");
  const byId = new Map(items.map(record).map(item => { const object = record(item.configObject); return [text(object.id), object]; }));
  assert.equal(byId.size, 104);
  for (const object of objects) {
    const latest = record(byId.get(object.id)?.latestVersion);
    assert.equal(latest.id, object.version);
    assert.equal(latest.rawSourceText, markdown("Current instructions"));
  }
  assert.equal(record(byId.get(objects[0]!.id)?.latestVersion).isDeletedVersion, true);
  const detail = await api(owner, `/v1/config-objects/${template}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(record(record(record(detail.body).item).latestVersion).id, currentVersion);
  const denied = await api(outsider, `/v1/plugins/${pluginId}/resolved`);
  assert.ok([403, 404].includes(denied.status));
  assert.ok(!JSON.stringify(denied.body).includes("Current instructions"));
})
