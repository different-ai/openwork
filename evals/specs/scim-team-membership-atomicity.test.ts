import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { server, test } from "@openwork/testkit";
import { parseOrgContextPayload } from "../../ee/apps/den-web/app/(den)/_lib/den-org.ts";

test("SCIM projection ownership is atomic and detached manual teams reject later IdP mutations", { timeout: 180_000 }, async ({ place, evidence }) => {
  await using den = await server({ place, web: false, org: { name: "SCIM Transaction Regression", members: { target: {}, control: {} } } });
  if (!den.database) throw new Error("This MySQL lock-witness test requires an isolated local testkit database.");
  const response = await denFetch(den.admin, "/v1/org", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const context = parseOrgContextPayload(response.body);
  if (!context) throw new Error("Missing organization context");
  const target = context.members.find((member) => member.user.email === den.members.target?.email);
  const control = context.members.find((member) => member.user.email === den.members.control?.email);
  if (!target?.userId || !control?.userId) throw new Error("Missing test members");

  // The child imports the real service and uses the testkit's disposable MySQL.
  // A held source-row lock stops reconciliation at its ownership UPDATE, after
  // the projection INSERT. MySQL's wait graph witnesses the competing org lock.
  const run = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { setTimeout as delay } from 'node:timers/promises';
    import { db } from './src/db.ts';
    import { eq, sql } from '@openwork-ee/den-db/drizzle';
    import { MemberTable, ScimProviderTable, ScimGroupTable, ScimGroupMemberTable, TeamTable, TeamMemberTable } from '@openwork-ee/den-db/schema';
    import { createDenTypeId } from '@openwork-ee/utils/typeid';
    import { createScimGroup, updateScimGroup, deleteScimGroup, reconcileScimGroupsForUser, setScimGroupMappingMode } from './src/scim-groups.ts';
    import { deleteOrganizationScimConnection } from './src/scim.ts';
    import { resolveOrganizationMemberAuthority } from './src/organization-team-roles.ts';
    const input = JSON.parse(process.env.SCIM_ATOMICITY_INPUT);
    const providerId = createDenTypeId('scimProvider');
    await db.insert(ScimProviderTable).values({ id: providerId, providerId: 'test-atomic-scim', scimToken: 'test-only', organizationId: input.orgId, groupMappingMode: 'create_teams' });
    const [provider] = await db.select().from(ScimProviderTable).where(eq(ScimProviderTable.id, providerId));
    const created = await createScimGroup({ provider, value: { displayName: 'Atomic Admins', members: [] } });
    assert.equal(created.ok, true);
    const group = created.group;
    assert.ok(group.teamId);
    await db.update(TeamTable).set({ grantsOrganizationAdmin: true }).where(eq(TeamTable.id, group.teamId));
    const members = () => db.select().from(TeamMemberTable).where(eq(TeamMemberTable.teamId, group.teamId));
    const sources = () => db.select().from(ScimGroupMemberTable).where(eq(ScimGroupMemberTable.groupId, group.id));
    const authority = () => resolveOrganizationMemberAuthority({ organizationId: input.orgId, memberId: input.memberId });
    const addPendingSource = async () => {
      const id = createDenTypeId('scimGroupMember');
      await db.insert(ScimGroupMemberTable).values({ id, groupId: group.id, providerId: provider.providerId, organizationId: input.orgId, remoteUserId: input.userId });
      return id;
    };
    const waitForBlocker = async (connectionId) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [rows] = await db.execute(sql.raw(
          'SELECT r.PROCESSLIST_ID AS connectionId, r.PROCESSLIST_INFO AS query FROM performance_schema.data_lock_waits w ' +
          'JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID ' +
          'JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID ' +
          'WHERE b.PROCESSLIST_ID = ' + Number(connectionId)
        ));
        if (rows.length) return rows[0];
        await delay(25);
      }
      const [waits] = await db.execute(sql.raw('SELECT * FROM performance_schema.data_lock_waits'));
      throw new Error('Expected blocked transaction behind connection ' + connectionId + '; waits: ' + JSON.stringify(waits));
    };

    const sourceId = await addPendingSource();
    let adding;
    let removing;
    await db.transaction(async (sourceLock) => {
      await sourceLock.select().from(ScimGroupMemberTable).where(eq(ScimGroupMemberTable.id, sourceId)).for('update');
      const [[connection]] = await sourceLock.execute(sql.raw('SELECT CONNECTION_ID() AS id'));
      adding = reconcileScimGroupsForUser({ provider, userId: input.userId }).then(() => null, (error) => error);
      const ownerUpdate = await waitForBlocker(connection.id);
      assert.match(ownerUpdate.query, /update .*scim_group_member/i);
      assert.equal((await sources())[0].teamMemberId, null);
      assert.deepEqual(await members(), [], 'projection INSERT must remain uncommitted while ownership UPDATE is blocked');
      assert.equal((await authority()).role, 'member');
      removing = updateScimGroup({ provider, groupId: group.id, operations: [{ op: 'remove', path: 'members' }] });
      const removalWait = await waitForBlocker(ownerUpdate.connectionId);
      assert.match(removalWait.query, /organization.*for update/i, 'removal must wait on the reconciler org lock, not delete the stale source');
    });
    assert.equal(await adding, null);
    assert.equal((await removing).ok, true);
    assert.deepEqual(await sources(), []);
    assert.deepEqual(await members(), []);
    assert.equal((await authority()).role, 'member');

    // Source UPDATE failure rolls back the already-executed TeamMember INSERT.
    await addPendingSource();
    await db.execute(sql.raw("CREATE TRIGGER scim_source_failure BEFORE UPDATE ON scim_group_member FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected ownership failure'"));
    try {
      await assert.rejects(reconcileScimGroupsForUser({ provider, userId: input.userId }), (error) => error.cause?.sqlMessage === 'injected ownership failure');
      assert.deepEqual(await members(), []);
      assert.equal((await sources())[0].teamMemberId, null);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER scim_source_failure'));
    }

    // A historical orphan projection must never be sufficient for mapped Admin.
    const orphanId = createDenTypeId('teamMember');
    await db.insert(TeamMemberTable).values({ id: orphanId, teamId: group.teamId, orgMembershipId: input.memberId, userId: input.userId });
    assert.equal((await authority()).role, 'member');
    await reconcileScimGroupsForUser({ provider, userId: input.userId });
    assert.equal((await sources())[0].teamMemberId, orphanId);
    assert.equal((await authority()).role, 'member,admin');

    // Concurrent PATCH additions read their current membership inside the lock.
    const patched = await Promise.all([
      updateScimGroup({ provider, groupId: group.id, operations: [{ op: 'add', path: 'members', value: [{ value: input.userId }] }] }),
      updateScimGroup({ provider, groupId: group.id, operations: [{ op: 'add', path: 'members', value: [{ value: input.controlUserId }] }] }),
    ]);
    assert.ok(patched.every((result) => result.ok));
    assert.deepEqual((await members()).map((member) => member.orgMembershipId).sort(), [input.memberId, input.controlId].sort());

    const second = await createScimGroup({ provider, value: { displayName: 'Detached Provider Team', members: [{ value: input.controlUserId }] } });
    assert.equal(second.ok, true);
    await setScimGroupMappingMode({ provider, mode: 'metadata_only' });
    assert.ok((await sources()).every((source) => source.teamMemberId === null));
    const preserved = await members();
    assert.equal(preserved.length, 2);
    assert.equal((await authority()).role, 'member');
    // Owner reapproval uses the real role-management route, not a fabricated role.
    const approve = async (teamId) => {
      const response = await fetch(input.apiUrl + '/v1/teams/' + teamId, { method: 'PATCH', headers: { authorization: 'Bearer ' + input.token, 'x-openwork-org-id': input.orgId, 'content-type': 'application/json' }, body: JSON.stringify({ grantsOrganizationAdmin: true }), signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, await response.text());
    };
    await approve(group.teamId);
    await approve(second.group.teamId);
    assert.equal((await authority()).role, 'member,admin');
    // Deliberately keep passing the stale create_teams provider object.
    assert.equal((await updateScimGroup({ provider, groupId: group.id, operations: [{ op: 'remove', path: 'members' }] })).ok, true);
    assert.deepEqual(await sources(), []);
    assert.deepEqual(await members(), preserved);
    assert.equal((await authority()).role, 'member,admin');
    assert.equal((await updateScimGroup({ provider, groupId: group.id, operations: [{ op: 'add', path: 'members', value: [{ value: input.ownerUserId }] }] })).ok, true);
    assert.equal((await sources())[0].teamMemberId, null);
    assert.deepEqual(await members(), preserved, 'metadata-only additions cannot project new manual memberships');
    await reconcileScimGroupsForUser({ provider, userId: input.ownerUserId });
    assert.deepEqual(await members(), preserved);
    await reconcileScimGroupsForUser({ provider, userId: input.userId });
    await setScimGroupMappingMode({ provider, mode: 'metadata_only' });
    assert.deepEqual(await members(), preserved);
    assert.equal((await authority()).role, 'member,admin', 'idempotent disable must not revoke manual reapproval');
    assert.equal((await deleteScimGroup({ provider, groupId: group.id })).ok, true);
    assert.deepEqual(await members(), preserved);
    assert.equal((await authority()).role, 'member,admin', 'detached group deletion cannot revoke manual authority');
    const secondMembers = await db.select().from(TeamMemberTable).where(eq(TeamMemberTable.teamId, second.group.teamId));
    assert.equal(await deleteOrganizationScimConnection(input.orgId), true);
    assert.deepEqual(await db.select().from(TeamMemberTable).where(eq(TeamMemberTable.teamId, second.group.teamId)), secondMembers);
    const [manualTeam] = await db.select().from(TeamTable).where(eq(TeamTable.id, second.group.teamId));
    assert.equal(manualTeam.grantsOrganizationAdmin, true, 'detached provider deletion cannot revoke manual reapproval');
    assert.deepEqual(await db.select().from(ScimProviderTable).where(eq(ScimProviderTable.id, provider.id)), []);
    const stale = await createScimGroup({ provider, value: { displayName: 'Deleted provider cannot recreate mappings' } });
    assert.equal(stale.ok, false);
    assert.equal(stale.status, 404);
    await reconcileScimGroupsForUser({ provider, userId: input.userId });
    assert.deepEqual(await db.select().from(ScimGroupTable).where(eq(ScimGroupTable.providerId, provider.providerId)), []);
    const [directMember] = await db.select().from(MemberTable).where(eq(MemberTable.id, input.memberId));
    assert.equal(directMember.role, 'member');
    console.log(JSON.stringify({ serializedRemoval: true, rollback: true, orphanDenied: true, patchUnion: true, detachedMembershipPreserved: true, detachedDeletionPreserved: true, staleProviderDenied: true }));
    process.exit(0);
  `], {
    cwd: fileURLToPath(new URL("../../ee/apps/den-api", import.meta.url)),
    timeout: 60_000,
    env: {
      ...process.env,
      DATABASE_URL: den.database.url,
      DB_MODE: "mysql",
      DATABASE_REDIS_URL: "",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      BETTER_AUTH_SECRET: "local-testkit-secret-not-for-production-use!!",
      DEN_BASE_URL: den.ref.apiUrl,
      OPENWORK_DEV_MODE: "1",
      SCIM_ATOMICITY_INPUT: JSON.stringify({ orgId: context.organization.id, memberId: target.id, userId: target.userId, controlId: control.id, controlUserId: control.userId, ownerUserId: context.currentMember.userId, apiUrl: den.ref.apiUrl, token: den.admin.token }),
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") throw new Error(error.stderr);
    throw error;
  });
  const output = run.stdout.trim().split("\n").at(-1);
  if (!output) throw new Error("No transaction witness result");
  const result: unknown = JSON.parse(output);
  expect(result).toEqual({ serializedRemoval: true, rollback: true, orphanDenied: true, patchUnion: true, detachedMembershipPreserved: true, detachedDeletionPreserved: true, staleProviderDenied: true });
  evidence.recordAssertionEvidence("SCIM reconciliation and removal share one atomic ownership transaction", "MySQL's wait graph proved removal blocked on the reconciler's org lock while source UPDATE was paused after projection INSERT. Neither uncommitted authority nor an orphan survived; an injected source-update error rolled back the projection, and a historical orphan was denied until reconciled.", true);
  evidence.recordAssertionEvidence("Metadata-only IdP operations cannot mutate manually reapproved teams", "Disable cleared source ownership pointers without deleting memberships. Owner reapproval survived stale-provider membership removal, repeated disable, group deletion, and provider deletion. Deleted providers could not create or reconcile mappings.", true);
});
