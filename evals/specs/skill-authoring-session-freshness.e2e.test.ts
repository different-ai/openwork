import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { expect } from "vitest";
import { localMysqlIsRunning, needs, queryDenDatabase, server, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !e2eTestsEnabled
  ? "skill authoring session freshness skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "skill authoring session freshness skipped — needs a real local Den"
    : !mysqlOpen
      ? "skill authoring session freshness skipped — needs MySQL on 127.0.0.1:3306"
      : "a stale admin session can author a private plugin and skill but cannot expand its audience org-wide";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireItem(body: unknown, label: string): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body.item)) {
    throw new Error(`${label} returned no item: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body.item;
}

function auth(session: DenSession, orgId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${session.token}`,
    ...(orgId ? { "x-openwork-org-id": orgId } : {}),
  };
}

test.skipIf(!e2eTestsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  const unique = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Skill Freshness ${unique}`;
  await using den = await server({ place, org: { name: organizationName } });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("skill authoring freshness requires the local isolated database handle");

  const orgsResult = await denFetch(den.admin, "/v1/me/orgs", { headers: auth(den.admin) });
  expect(orgsResult.response.status).toBe(200);
  const organizations = isRecord(orgsResult.body) && Array.isArray(orgsResult.body.orgs)
    ? orgsResult.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((entry) => entry.name === organizationName);
  const orgId = organization && typeof organization.id === "string" ? organization.id : "";
  expect(orgId).toMatch(/^org_/);

  const exposedSkillName = `exposed-session-skill-${unique}`;
  const exposedInitialSource = `---\nname: ${exposedSkillName}\ndescription: Proves exposed authoring requires freshness.\n---\n\nReturn the initial exposed skill source.`;
  const exposedPluginResult = await denFetch(den.admin, "/v1/plugins", {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({
      name: `Exposed Session Plugin ${unique}`,
      orgWide: true,
    }),
  });
  expect(exposedPluginResult.response.status).toBe(201);
  const exposedPlugin = requireItem(exposedPluginResult.body, "Exposed plugin creation");
  const exposedPluginId = typeof exposedPlugin.id === "string" ? exposedPlugin.id : "";
  expect(exposedPluginId).toMatch(/^plg_/);

  const exposedSkillResult = await denFetch(den.admin, "/v1/config-objects", {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({
      type: "skill",
      pluginIds: [exposedPluginId],
      sourceMode: "cloud",
      input: { rawSourceText: exposedInitialSource },
    }),
  });
  expect(exposedSkillResult.response.status).toBe(201);
  const exposedSkill = requireItem(exposedSkillResult.body, "Exposed skill creation");
  const exposedConfigObjectId = typeof exposedSkill.id === "string" ? exposedSkill.id : "";
  expect(exposedConfigObjectId).toMatch(/^cob_/);
  evidence.recordAssertionEvidence(
    "The freshness boundary has an exposed plugin and existing skill",
    `Fresh setup created org-wide plugin ${exposedPluginId} with skill ${exposedConfigObjectId}.`,
    exposedPluginId.startsWith("plg_") && exposedConfigObjectId.startsWith("cob_"),
  );

  await queryDenDatabase(
    databaseUrl,
    "UPDATE `session` SET created_at = DATE_SUB(NOW(3), INTERVAL 20 MINUTE) WHERE token = ?",
    [den.admin.token],
  );
  const sessionRows = await queryDenDatabase(
    databaseUrl,
    "SELECT created_at, TIMESTAMPDIFF(SECOND, created_at, NOW(3)) AS age_seconds FROM `session` WHERE token = ?",
    [den.admin.token],
  );
  expect(sessionRows).toHaveLength(1);
  const sessionRow = sessionRows[0];
  const ageSeconds = isRecord(sessionRow) && typeof sessionRow.age_seconds === "number" ? sessionRow.age_seconds : 0;
  expect(ageSeconds).toBeGreaterThan(15 * 60);
  evidence.recordAssertionEvidence(
    "The admin credential is older than the privileged-session window",
    `The credential's database session is ${ageSeconds} seconds old, beyond the 900-second freshness limit.`,
    ageSeconds > 15 * 60,
  );

  const orgWidePlugin = await denFetch(den.admin, "/v1/plugins", {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({
      name: `Blocked Org-wide Plugin ${unique}`,
      orgWide: true,
    }),
  });
  expect(orgWidePlugin.response.status).toBe(403);
  expect(orgWidePlugin.body).toEqual({
    error: "reauth",
    reason: "fresh_auth_required",
    message: "For security, confirm it's you before changing workspace settings.",
  });
  evidence.recordAssertionEvidence(
    "Creating an org-wide plugin still requires fresh authentication",
    "The stale credential received exact HTTP 403 reauth/fresh_auth_required before creating an org-wide plugin.",
    orgWidePlugin.response.status === 403
      && isRecord(orgWidePlugin.body)
      && orgWidePlugin.body.error === "reauth"
      && orgWidePlugin.body.reason === "fresh_auth_required",
  );

  const skillName = `stale-session-skill-${unique}`;
  const initialSource = `---\nname: ${skillName}\ndescription: Proves stale-session private authoring.\n---\n\nReturn the initial private skill source.`;
  const pluginResult = await denFetch(den.admin, "/v1/plugins", {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({
      name: `Stale Session Plugin ${unique}`,
      orgWide: false,
    }),
  });
  expect(pluginResult.response.status).toBe(201);
  const plugin = requireItem(pluginResult.body, "Private plugin creation");
  const pluginId = typeof plugin.id === "string" ? plugin.id : "";
  expect(pluginId).toMatch(/^plg_/);
  evidence.recordAssertionEvidence(
    "The stale credential can create a private plugin",
    `POST /v1/plugins returned HTTP ${pluginResult.response.status} without expanding the plugin audience.`,
    pluginResult.response.status === 201 && pluginId.startsWith("plg_"),
  );

  const created = await denFetch(den.admin, "/v1/config-objects", {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({
      type: "skill",
      pluginIds: [pluginId],
      sourceMode: "cloud",
      input: { rawSourceText: initialSource },
    }),
  });
  expect(created.response.status).toBe(201);
  const skill = requireItem(created.body, "Private skill creation");
  const configObjectId = typeof skill.id === "string" ? skill.id : "";
  expect(configObjectId).toMatch(/^cob_/);
  evidence.recordAssertionEvidence(
    "The same stale credential can create private skill content",
    `POST /v1/config-objects returned HTTP ${created.response.status} while adding a private skill to the admin's plugin.`,
    created.response.status === 201 && configObjectId.startsWith("cob_"),
  );

  const renamedPluginName = `Renamed Private Plugin ${unique}`;
  const renamedPlugin = await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}`, {
    method: "PATCH",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({ name: renamedPluginName }),
  });
  expect(renamedPlugin.response.status).toBe(200);
  const renamedPluginDetail = await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}`, {
    headers: auth(den.admin, orgId),
  });
  expect(renamedPluginDetail.response.status).toBe(200);
  const observedRenamedPlugin = requireItem(renamedPluginDetail.body, "Renamed private plugin");
  expect(observedRenamedPlugin.name).toBe(renamedPluginName);
  evidence.recordAssertionEvidence(
    "The stale credential can rename a private plugin",
    `A subsequent plugin detail read returned the exact name ${renamedPluginName}.`,
    renamedPlugin.response.status === 200 && observedRenamedPlugin.name === renamedPluginName,
  );

  const updatedSource = `---\nname: ${skillName}\ndescription: Proves stale-session private authoring.\n---\n\nReturn the updated private skill source: ${unique}.`;
  const versioned = await denFetch(den.admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions`, {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({ input: { rawSourceText: updatedSource }, reason: "spec: stale-session skill edit" }),
  });
  expect(versioned.response.status).toBe(201);

  const detail = await denFetch(den.admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}`, {
    headers: auth(den.admin, orgId),
  });
  expect(detail.response.status).toBe(200);
  const updatedItem = requireItem(detail.body, "Updated config object");
  const latestVersion = isRecord(updatedItem.latestVersion) ? updatedItem.latestVersion : null;
  const observedSource = latestVersion && typeof latestVersion.rawSourceText === "string"
    ? latestVersion.rawSourceText
    : "";
  expect(observedSource).toBe(updatedSource);
  expect(observedSource).not.toBe(initialSource);
  evidence.recordAssertionEvidence(
    "The stale credential can save and read a new private skill version",
    "The config object's latest immutable version exposes the exact updated SKILL.md source rather than the initial source.",
    versioned.response.status === 201 && observedSource === updatedSource && observedSource !== initialSource,
  );

  const deletedSkill = await denFetch(den.admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}/delete`, {
    method: "POST",
    headers: auth(den.admin, orgId),
  });
  expect(deletedSkill.response.status).toBe(200);
  expect(requireItem(deletedSkill.body, "Deleted private skill").status).toBe("deleted");
  const restoredSkill = await denFetch(den.admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}/restore`, {
    method: "POST",
    headers: auth(den.admin, orgId),
  });
  expect(restoredSkill.response.status).toBe(200);
  expect(requireItem(restoredSkill.body, "Restored private skill").status).toBe("active");
  evidence.recordAssertionEvidence(
    "The stale credential can delete and restore a private skill",
    "The lifecycle responses exposed deleted and then active status for the same private config object.",
    requireItem(deletedSkill.body, "Deleted private skill evidence").status === "deleted"
      && requireItem(restoredSkill.body, "Restored private skill evidence").status === "active",
  );

  const archivedPlugin = await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/archive`, {
    method: "POST",
    headers: auth(den.admin, orgId),
  });
  expect(archivedPlugin.response.status).toBe(200);
  expect(requireItem(archivedPlugin.body, "Archived private plugin").status).toBe("archived");
  const restoredPlugin = await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/restore`, {
    method: "POST",
    headers: auth(den.admin, orgId),
  });
  expect(restoredPlugin.response.status).toBe(200);
  expect(requireItem(restoredPlugin.body, "Restored private plugin").status).toBe("active");
  evidence.recordAssertionEvidence(
    "The stale credential can archive and restore a private plugin",
    "The lifecycle responses exposed archived and then active status for the same private plugin.",
    requireItem(archivedPlugin.body, "Archived private plugin evidence").status === "archived"
      && requireItem(restoredPlugin.body, "Restored private plugin evidence").status === "active",
  );

  const blockedSkillName = `blocked-exposed-skill-${unique}`;
  const blockedCreate = await denFetch(den.admin, "/v1/config-objects", {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({
      type: "skill",
      pluginIds: [exposedPluginId],
      sourceMode: "cloud",
      input: {
        rawSourceText: `---\nname: ${blockedSkillName}\ndescription: Must not be written.\n---\n\nBlocked exposed content.`,
      },
    }),
  });
  expect(blockedCreate.response.status).toBe(403);
  expect(blockedCreate.body).toEqual({
    error: "reauth",
    reason: "fresh_auth_required",
    message: "For security, confirm it's you before changing workspace settings.",
  });
  const blockedRows = await queryDenDatabase(
    databaseUrl,
    "SELECT id FROM config_object WHERE organization_id = ? AND title = ?",
    [orgId, blockedSkillName],
  );
  expect(blockedRows).toHaveLength(0);
  evidence.recordAssertionEvidence(
    "Stale authentication is rejected before writing content to an exposed plugin",
    "POST returned exact HTTP 403 reauth/fresh_auth_required and the isolated database contains no config_object with the requested title.",
    blockedCreate.response.status === 403
      && isRecord(blockedCreate.body)
      && blockedCreate.body.reason === "fresh_auth_required"
      && blockedRows.length === 0,
  );

  const blockedRevision = await denFetch(den.admin, `/v1/config-objects/${encodeURIComponent(exposedConfigObjectId)}/versions`, {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({
      input: { rawSourceText: `${exposedInitialSource}\n\nBlocked revision ${unique}.` },
      reason: "spec: stale-session exposed skill edit",
    }),
  });
  expect(blockedRevision.response.status).toBe(403);
  expect(blockedRevision.body).toEqual({
    error: "reauth",
    reason: "fresh_auth_required",
    message: "For security, confirm it's you before changing workspace settings.",
  });
  evidence.recordAssertionEvidence(
    "Revising an existing exposed skill requires fresh authentication",
    "The stale credential received exact HTTP 403 reauth/fresh_auth_required when creating a version for the org-wide plugin's skill.",
    blockedRevision.response.status === 403
      && isRecord(blockedRevision.body)
      && blockedRevision.body.error === "reauth"
      && blockedRevision.body.reason === "fresh_auth_required",
  );

  const audienceChange = await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: auth(den.admin, orgId),
    body: JSON.stringify({ orgWide: true, role: "viewer" }),
  });
  expect(audienceChange.response.status).toBe(403);
  expect(audienceChange.body).toEqual({
    error: "reauth",
    reason: "fresh_auth_required",
    message: "For security, confirm it's you before changing workspace settings.",
  });
  evidence.recordAssertionEvidence(
    "Expanding the plugin audience still requires fresh authentication",
    "The same stale credential received exact HTTP 403 reauth/fresh_auth_required when granting org-wide viewer access.",
    audienceChange.response.status === 403
      && isRecord(audienceChange.body)
      && audienceChange.body.error === "reauth"
      && audienceChange.body.reason === "fresh_auth_required",
  );
});
