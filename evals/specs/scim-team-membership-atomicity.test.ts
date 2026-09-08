import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { server, test } from "@openwork/testkit";
import { parseTeamAdminContext } from "./helpers/team-admin-context.ts";
import { enableScimFixtureSso } from "./helpers/scim-fixture.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

test("SCIM projection ownership is atomic and detached manual teams reject later IdP mutations", { timeout: 180_000 }, async ({ place, evidence }) => {
  await using den = await server({ place, web: false, org: { name: "SCIM Transaction Regression", members: { target: {}, control: {} } } });
  if (!den.database) throw new Error("This MySQL lock-witness test requires an isolated local testkit database.");
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const response = await denFetch(den.admin, "/v1/org", { headers });
  const context = parseTeamAdminContext(response.body);
  const target = context.members.find((member) => member.user.email === den.members.target?.email);
  const control = context.members.find((member) => member.user.email === den.members.control?.email);
  if (!target?.userId || !control?.userId) throw new Error("Missing test members");
  const login = await denFetch(den.admin, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }) });
  const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing cookie");
  const privilegedHeaders = { ...headers, cookie, "x-openwork-org-id": context.organization.id };
  const sso = await denFetch(den.admin, "/v1/sso/saml", { method: "POST", headers: privilegedHeaders, body: JSON.stringify({ issuer: `http://127.0.0.1/atomic-${Date.now()}`, domain: "atomic-scim.test", entryPoint: "https://idp.example.test/sso", cert: "test-signing-certificate", audience: den.ref.apiUrl }) });
  expect(sso.response.status, sso.text).toBe(201);
  await enableScimFixtureSso(den.database, context.organization.id);
  const tokenResult = await denFetch(den.admin, "/v1/scim/token", { method: "POST", headers: privilegedHeaders });
  expect(tokenResult.response.status, tokenResult.text).toBe(201);
  const scimToken = record(tokenResult.body).scimToken;
  if (typeof scimToken !== "string") throw new Error("Missing SCIM token");

  // The fixture controls only disposable MySQL locks/data. Every mutation under
  // test crosses Den's HTTP boundary; no product modules or test runners load here.
  const run = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { setTimeout as delay } from 'node:timers/promises';
    const { createPool } = createRequire(import.meta.resolve('@openwork/env'))('mysql2/promise');
    const db = createPool(process.env.DATABASE_URL);
    const input = JSON.parse(process.env.SCIM_ATOMICITY_INPUT);
    const http = async (path, method = 'GET', body, token = input.token) => {
      const response = await fetch(input.apiUrl + path, { method, headers: { authorization: 'Bearer ' + token, 'x-openwork-org-id': input.orgId, origin: input.webUrl, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, text };
    };
    const scim = (path, method, body) => http('/api/auth/scim/v2/Groups' + path, method, body, input.scimToken);
    const requireStatus = (result, status = 200) => { assert.equal(result.status, status, result.text); return result.body; };
    requireStatus(await http('/v1/scim', 'PATCH', { groupMappingMode: 'create_teams' }));
    const group = requireStatus(await scim('', 'POST', { displayName: 'Atomic Admins', members: [] }), 201);
    const org = () => http('/v1/org').then((result) => requireStatus(result));
    const team = (await org()).teams.find((team) => team.name === 'Atomic Admins');
    const approve = async (id) => requireStatus(await http('/v1/teams/' + id, 'PATCH', { grantsOrganizationAdmin: true }));
    await approve(team.id);
    const members = async () => (await db.execute('SELECT * FROM team_member WHERE team_id = ? ORDER BY id', [team.id]))[0];
    const sources = async () => (await db.execute('SELECT * FROM scim_group_member WHERE group_id = ? ORDER BY id', [group.id]))[0];
    const authority = async () => (await org()).members.find((member) => member.id === input.memberId).effectiveRole;
    const [[provider]] = await db.execute('SELECT * FROM scim_provider WHERE organization_id = ?', [input.orgId]);
    const sourceId = group.id.replace('scg_', 'sgm_');
    const addPendingSource = () => db.execute('INSERT INTO scim_group_member (id, group_id, provider_id, organization_id, remote_user_id) VALUES (?, ?, ?, ?, ?)', [sourceId, group.id, provider.provider_id, input.orgId, input.userId]);
    const patch = (operations) => scim('/' + group.id, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: operations });
    const add = (value) => patch([{ op: 'add', path: 'members', value: [{ value }] }]);
    const [[databaseVersion]] = await db.query('SELECT VERSION() AS version');
    // Daytona's server snapshot uses MariaDB; retain the same wait-edge proof
    // using its InnoDB catalog rather than MySQL 8's performance-schema catalog.
    const waitForBlocker = async (id) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (databaseVersion.version.includes('MariaDB')) {
          // Read each live catalog once: self-joining INNODB_TRX can miss edges.
          const [transactions] = await db.query('SELECT trx_id, trx_mysql_thread_id, trx_query FROM information_schema.INNODB_TRX');
          const [waits] = await db.query('SELECT requesting_trx_id, blocking_trx_id FROM information_schema.INNODB_LOCK_WAITS');
          const blocker = transactions.find((row) => Number(row.trx_mysql_thread_id) === Number(id));
          const edge = blocker && waits.find((row) => String(row.blocking_trx_id) === String(blocker.trx_id));
          const requester = edge && transactions.find((row) => String(row.trx_id) === String(edge.requesting_trx_id));
          if (requester) return { connectionId: requester.trx_mysql_thread_id, query: requester.trx_query };
        } else {
          const [rows] = await db.execute('SELECT r.PROCESSLIST_ID AS connectionId, r.PROCESSLIST_INFO AS query FROM performance_schema.data_lock_waits w JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID WHERE b.PROCESSLIST_ID = ?', [id]);
          if (rows.length) return rows[0];
        }
        await delay(25);
      }
      throw new Error('Expected blocked transaction behind connection ' + id);
    };
    await addPendingSource();
    const sourceLock = await db.getConnection();
    let adding, removing;
    try {
      await sourceLock.beginTransaction();
      await sourceLock.execute('SELECT id FROM scim_group_member WHERE id = ? FOR UPDATE', [sourceId]);
      const [[connection]] = await sourceLock.execute('SELECT CONNECTION_ID() AS id');
      adding = add(input.userId);
      const ownerUpdate = await waitForBlocker(connection.id);
      assert.match(ownerUpdate.query, /update .*scim_group_member/i);
      assert.equal((await sources())[0].team_member_id, null);
      assert.deepEqual(await members(), [], 'uncommitted projection must not escape ownership transaction');
      assert.equal(await authority(), 'member');
      removing = patch([{ op: 'remove', path: 'members' }]);
      const removalWait = await waitForBlocker(ownerUpdate.connectionId);
      assert.match(removalWait.query, /organization.*for update/i);
      await sourceLock.commit();
    } finally { await sourceLock.rollback(); sourceLock.release(); }
    requireStatus(await adding);
    requireStatus(await removing);
    assert.deepEqual(await sources(), []);
    assert.deepEqual(await members(), []);
    assert.equal(await authority(), 'member');
    await addPendingSource();
    await db.query("CREATE TRIGGER scim_source_failure BEFORE UPDATE ON scim_group_member FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected ownership failure'");
    try {
      assert.equal((await add(input.userId)).status, 500);
      assert.deepEqual(await members(), []);
      assert.equal((await sources())[0].team_member_id, null);
    } finally { await db.query('DROP TRIGGER scim_source_failure'); }
    const orphanId = team.id.replace('tem_', 'tmb_');
    await db.execute('INSERT INTO team_member (id, team_id, org_membership_id, user_id) VALUES (?, ?, ?, ?)', [orphanId, team.id, input.memberId, input.userId]);
    assert.equal(await authority(), 'member');
    requireStatus(await add(input.userId));
    assert.equal((await sources())[0].team_member_id, orphanId);
    assert.equal(await authority(), 'member,admin');
    for (const result of await Promise.all([add(input.userId), add(input.controlUserId)])) requireStatus(result);
    assert.deepEqual((await members()).map((member) => member.org_membership_id).sort(), [input.memberId, input.controlId].sort());
    requireStatus(await scim('', 'POST', { displayName: 'Detached Provider Team', members: [{ value: input.controlUserId }] }), 201);
    const secondTeam = (await org()).teams.find((team) => team.name === 'Detached Provider Team');
    requireStatus(await http('/v1/scim', 'PATCH', { groupMappingMode: 'metadata_only' }));
    assert.ok((await sources()).every((source) => source.team_member_id === null));
    const preserved = await members();
    assert.equal(preserved.length, 2);
    assert.equal(await authority(), 'member');
    await approve(team.id);
    await approve(secondTeam.id);
    requireStatus(await patch([{ op: 'remove', path: 'members' }]));
    assert.deepEqual(await sources(), []);
    assert.deepEqual(await members(), preserved);
    assert.equal(await authority(), 'member,admin');
    requireStatus(await add(input.ownerUserId));
    assert.equal((await sources())[0].team_member_id, null);
    assert.deepEqual(await members(), preserved);
    requireStatus(await http('/v1/scim', 'PATCH', { groupMappingMode: 'metadata_only' }));
    assert.equal(await authority(), 'member,admin');
    requireStatus(await scim('/' + group.id, 'DELETE'), 204);
    assert.deepEqual(await members(), preserved);
    assert.equal(await authority(), 'member,admin');
    const [secondMembers] = await db.execute('SELECT * FROM team_member WHERE team_id = ? ORDER BY id', [secondTeam.id]);
    requireStatus(await http('/v1/scim', 'DELETE'), 204);
    assert.deepEqual((await db.execute('SELECT * FROM team_member WHERE team_id = ? ORDER BY id', [secondTeam.id]))[0], secondMembers);
    assert.equal((await org()).teams.find((team) => team.id === secondTeam.id).grantsOrganizationAdmin, true);
    assert.equal((await scim('', 'POST', { displayName: 'Stale provider' })).status, 401);
    assert.deepEqual((await db.execute('SELECT id FROM scim_group WHERE provider_id = ?', [provider.provider_id]))[0], []);
    assert.equal((await org()).members.find((member) => member.id === input.memberId).role, 'member');
    await db.end();
    console.log(JSON.stringify({ serializedRemoval: true, rollback: true, orphanDenied: true, patchUnion: true, detachedMembershipPreserved: true, detachedDeletionPreserved: true, staleProviderDenied: true }));
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 90_000,
    env: { ...process.env, DATABASE_URL: den.database.url, SCIM_ATOMICITY_INPUT: JSON.stringify({ orgId: context.organization.id, memberId: target.id, userId: target.userId, controlId: control.id, controlUserId: control.userId, ownerUserId: context.currentMember.userId, apiUrl: den.ref.apiUrl, webUrl: den.ref.webUrl, token: den.admin.token, scimToken }) },
  }).catch((error: unknown) => {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") throw new Error(error.stderr);
    throw error;
  });
  const output = run.stdout.trim().split("\n").at(-1);
  if (!output) throw new Error("No transaction witness result");
  expect(JSON.parse(output)).toEqual({ serializedRemoval: true, rollback: true, orphanDenied: true, patchUnion: true, detachedMembershipPreserved: true, detachedDeletionPreserved: true, staleProviderDenied: true });
  evidence.recordAssertionEvidence("SCIM HTTP add/remove uses one ownership transaction", "MySQL's wait graph proves removal waits on the add transaction's org lock while source UPDATE is blocked after projection INSERT. A trigger-induced ownership failure rolls back the insert, and a historical orphan grants nothing until reconciled.", true);
  evidence.recordAssertionEvidence("Detached manual teams survive later IdP mutations", "Disable clears ownership pointers without deleting memberships. Real Owner reapproval survives IdP member removal/addition, repeated disable, group deletion and provider deletion; the deleted provider token cannot recreate mappings.", true);
});
