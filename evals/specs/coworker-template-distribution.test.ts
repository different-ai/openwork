import { expect } from "vitest";
import { assignPluginToMarketplace, createMarketplace, denFetch, grantMarketplaceAccess, readCurrentOrganizationMemberId, type DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, server, test } from "@openwork/testkit";

const remote = process.env.OPENWORK_EVAL_DAYTONA === "1" || Boolean(process.env.OPENWORK_EVAL_DEN_API_URL);
const mysql = remote || await localMysqlIsRunning();
const redis = remote || await localRedisIsRunning();
const title = !mysql ? "coworker distribution skipped — needs MySQL on 127.0.0.1:3306"
  : !redis ? "coworker distribution skipped — needs Redis on 127.0.0.1:6379"
    : "Connect assigns reusable coworkers through teams and marketplaces while preserving member boundaries";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a response object.");
  return { ...value };
}
function id(value: unknown): string {
  const item = record(value);
  if (typeof item.id !== "string" || !item.id) throw new Error("Expected a resource ID.");
  return item.id;
}
function entry(value: unknown) {
  const item = record(value);
  const profile = record(item.template);
  if (typeof item.versionId !== "string" || typeof item.assigned !== "boolean" || typeof profile.name !== "string" || typeof profile.instructions !== "string") throw new Error("Expected a versioned coworker template.");
  return { id: id(item), versionId: item.versionId, assigned: item.assigned, template: { name: profile.name, instructions: profile.instructions } };
}

function template(name: string) {
  return { kind: "coworker", schemaVersion: 1, name, description: "A prepared marketing teammate", role: "Marketing", mission: "Help plan campaigns", instructions: "Ask for the audience before drafting.", provisioning: "automatic" };
}

test.skipIf(!mysql || !redis)(title, { timeout: 300_000 }, async ({ place, evidence }) => {
  await using den = await server({ place, org: { name: "Coworker distribution", admin: { name: "Preview operator" }, members: { teammate: { name: "Team Member" }, outsider: { name: "Other Member" } } } });
  const admin = den.admin;
  const teammate = den.members.teammate!;
  const outsider = den.members.outsider!;
  let organizationId = "";
  async function request(session: DenSession, path: string, method = "GET", body?: unknown, status = 200): Promise<Record<string, unknown>> {
    const result = await denFetch(session, path, { method, headers: { authorization: `Bearer ${session.token}`, ...(organizationId ? { "x-openwork-org-id": organizationId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(result.response.status, `${method} ${path}: ${result.text}`).toBe(status);
    return record(result.body);
  }
  async function available(session: DenSession, pageSize = 100) {
    const items: ReturnType<typeof entry>[] = [];
    let cursor = "";
    do {
      const page = await request(session, `/v1/me/coworkers?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!Array.isArray(page.items)) throw new Error("Expected a template page.");
      items.push(...page.items.map(entry));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : "";
    } while (cursor);
    return items;
  }
  const organizations = await request(admin, "/v1/me/orgs");
  if (!Array.isArray(organizations.orgs) || !organizations.orgs[0]) throw new Error("Expected the fixture organization.");
  organizationId = id(organizations.orgs[0]);
  const capabilitiesPath = `/v1/admin/organizations/${organizationId}/capabilities`;
  const preparedInput = { schemaVersion: "openwork.coworker.v1", normalizedPayloadJson: template("Disabled template") };
  expect(await request(admin, "/v1/me/coworkers")).toMatchObject({ enabled: false, items: [] });
  await request(admin, "/v1/config-objects", "POST", { type: "agent", sourceMode: "cloud", input: preparedInput }, 403);
  await request(admin, "/v1/plugins", "POST", { name: "Disabled bundle", components: [{ type: "agent", input: preparedInput }] }, 403);
  await request(teammate, capabilitiesPath, "PUT", { capabilities: { coworkerTeams: true } }, 403);
  const otherOrganization = id((await request(admin, "/v1/org", "POST", { name: "Unenabled organization" }, 201)).organization);
  await request(admin, capabilitiesPath, "PUT", { capabilities: { coworkerTeams: true } });
  expect(await request(admin, "/v1/me/coworkers")).toMatchObject({ enabled: true, items: [] });
  const otherCatalog = await denFetch(admin, "/v1/me/coworkers", { headers: { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": otherOrganization } });
  expect(otherCatalog.response.status).toBe(200);
  expect(otherCatalog.body).toMatchObject({ enabled: false, items: [] });
  await request(admin, "/api/auth/organization/set-active", "POST", { organizationId });
  evidence.recordAssertionEvidence("Prepared teams require an explicit platform-admin opt-in for each organization", "New organizations defaulted off. Both direct template creation and bundle creation returned 403. A member could not enable the flag. Enabling the first organization left the second organization disabled on the same server.", true);
  const teammateId = await readCurrentOrganizationMemberId(teammate);
  const outsiderId = await readCurrentOrganizationMemberId(outsider);
  const pluginId = id((await request(admin, "/v1/plugins", "POST", { name: "Marketing team", components: [
    { type: "agent", input: { schemaVersion: "openwork.coworker.v1", normalizedPayloadJson: template("Campaign partner") } },
    { type: "agent", input: { schemaVersion: "openwork.coworker.v1", normalizedPayloadJson: template("Research partner") } },
  ] }, 201)).item);
  const originals = await available(admin, 1);
  expect(originals).toHaveLength(2);
  expect(originals.every((item) => item.assigned === false)).toBe(true);
  expect(await available(teammate)).toEqual([]);
  expect(await available(outsider)).toEqual([]);

  const teamId = id((await request(admin, "/v1/teams", "POST", { name: "Marketing", memberIds: [] }, 201)).team);
  await request(admin, `/v1/plugins/${pluginId}/access`, "POST", { teamId, role: "viewer" }, 201);
  expect(await available(teammate)).toEqual([]);
  // Membership is added after the coworker bundle was assigned to the team.
  await request(admin, `/v1/teams/${teamId}`, "PATCH", { memberIds: [teammateId] });
  const inherited = await available(teammate, 1);
  expect(inherited.map((item) => item.template.name).sort()).toEqual(["Campaign partner", "Research partner"]);
  expect(inherited.every((item) => item.assigned === true)).toBe(true);
  expect(await available(outsider)).toEqual([]);
  const campaign = inherited.find((item) => item.template.name === "Campaign partner");
  if (!campaign) throw new Error("The campaign coworker was not delivered.");
  await request(teammate, `/v1/config-objects/${campaign.id}/versions`, "POST", { input: { schemaVersion: "openwork.coworker.v1", normalizedPayloadJson: template("Changed by a viewer") } }, 403);
  await request(teammate, `/v1/plugins/${pluginId}/access`, "POST", { orgMembershipId: outsiderId, role: "viewer" }, 403);
  evidence.recordAssertionEvidence("Joining an assigned team supplies its coworkers without rights to edit templates or manage grants", "An existing team bundle became visible and assigned after the member joined. The unrelated member saw no templates; viewer version creation and changing plugin grants both returned 403. Creator visibility alone returned assigned=false, including across pagination.", true);

  const marketplace = await createMarketplace(admin, { name: "Marketing starter team" });
  await assignPluginToMarketplace(admin, marketplace.id, pluginId);
  await grantMarketplaceAccess(admin, marketplace.id, { orgMembershipId: outsiderId });
  expect((await available(admin)).every((item) => !item.assigned)).toBe(true);
  const catalog = await available(outsider);
  expect(catalog).toHaveLength(2);
  expect(catalog.every((item) => item.assigned)).toBe(true);
  await request(admin, `/v1/teams/${teamId}`, "PATCH", { memberIds: [] });
  expect(await available(teammate)).toEqual([]);
  expect(await available(outsider)).toHaveLength(2);
  await request(admin, `/v1/plugins/${pluginId}/archive`, "POST");
  expect(await available(outsider)).toEqual([]);
  await request(admin, `/v1/plugins/${pluginId}/restore`, "POST");
  expect(await available(outsider)).toHaveLength(2);
  evidence.recordAssertionEvidence("Marketplace assignments and team removals govern future coworker delivery", "An individually granted marketplace supplied both coworkers; removing another member from the team revoked only that member's discovery. Archiving the plugin removed marketplace delivery and restoring it restored delivery.", true);

  await request(admin, capabilitiesPath, "PUT", { capabilities: { coworkerTeams: false } });
  expect(await request(outsider, "/v1/me/coworkers")).toMatchObject({ enabled: false, items: [] });
  await request(admin, `/v1/config-objects/${campaign.id}/versions`, "POST", { input: preparedInput }, 403);
  // Clearing the override must restore the default-off state, not a stored true.
  await request(admin, capabilitiesPath, "PUT", { capabilities: { coworkerTeams: null } });
  expect(await request(admin, "/v1/me/coworkers")).toMatchObject({ enabled: false, items: [] });
  await request(admin, capabilitiesPath, "PUT", { capabilities: { coworkerTeams: true } });
  expect(await available(outsider)).toHaveLength(2);
  evidence.recordAssertionEvidence("Disabling prepared teams stops marketplace delivery and editing without deleting templates", "Turning the organization flag off immediately removed discovery and rejected version creation. Clearing the override stayed off. Re-enabling restored the same two assigned templates.", true);

  const revised = { ...template("Campaign partner"), instructions: "Ask for an approved brief before drafting." };
  await request(admin, `/v1/config-objects/${campaign.id}/versions`, "POST", { input: { schemaVersion: "openwork.coworker.v1", normalizedPayloadJson: revised } }, 201);
  const revision = (await available(outsider)).find((item) => item.id === campaign.id);
  if (!revision) throw new Error("The revised template was not delivered.");
  expect(revision.versionId).not.toBe(campaign.versionId);
  expect(revision.template.instructions).toBe(revised.instructions);
  // A direct person grant uses the same native assignment path.
  await request(admin, `/v1/config-objects/${campaign.id}/access`, "POST", { orgMembershipId: teammateId, role: "viewer" }, 201);
  expect(await available(teammate)).toEqual([expect.objectContaining({ id: campaign.id, assigned: true })]);
  for (const field of ["memory", "apiKey", "workspaceId", "automations", "model"]) {
    await request(admin, "/v1/config-objects", "POST", { type: "agent", sourceMode: "cloud", input: { schemaVersion: "openwork.coworker.v1", normalizedPayloadJson: { ...template("Invalid"), [field]: "must not travel" } } }, 400);
  }
  await request(admin, `/v1/config-objects/${campaign.id}/archive`, "POST");
  expect(await available(teammate)).toEqual([]);
  expect(await available(outsider)).toHaveLength(1);
  evidence.recordAssertionEvidence("Versioned templates support direct assignment and exclude nonportable fields", "A new version kept the template identity and changed its version ID and instructions. A direct person grant assigned that template. Memory, API key, workspace ID, automation, and model fields each returned 400. Archiving the template removed delivery through both direct and marketplace grants.", true);
});
