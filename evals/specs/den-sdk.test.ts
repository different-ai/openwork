import { expect } from "vitest";
import { createDenClient } from "@openwork/sdk";
import { denFetch } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, server, test } from "@openwork/testkit";

const remote = process.env.OPENWORK_EVAL_DAYTONA === "1" || Boolean(process.env.OPENWORK_EVAL_DEN_API_URL);
const available = remote || (await localMysqlIsRunning() && await localRedisIsRunning());

test.skipIf(!available)(
  `an integration authenticates and manages teams with the generated Den SDK${available ? "" : " — needs local MySQL and Redis"}`,
  { timeout: 300_000 },
  async ({ evidence, place }) => {
    console.log(`placement: ${place.kind} (PR lane resolved by testkit)`);
    await using den = await server({ place, web: false, org: { name: "SDK integration", members: {} } });
    let defaultUrl = "";
    const defaultClient = createDenClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        defaultUrl = request.url;
        // Route the default production URL to the isolated test server.
        return fetch(new Request(`${den.ref.apiUrl}${new URL(request.url).pathname}`, request));
      },
    });
    const defaultHealth = await defaultClient.getHealth();
    expect(defaultUrl).toBe("https://api.openworklabs.com/health");
    expect(defaultHealth.response.status).toBe(200);
    const anonymous = createDenClient({ baseUrl: den.ref.apiUrl });
    const health = await anonymous.getHealth();
    expect(health.response.status).toBe(200);
    const denied = await anonymous.getV1Me();
    expect(denied.response.status).toBe(401);
    expect(denied.data).toBeUndefined();
    evidence.recordAssertionEvidence("Public health and protected identity", "Health succeeds without credentials; identity returns 401 with no data.",
      health.response.status === 200 && denied.response.status === 401 && denied.data === undefined);
    evidence.recordAssertionEvidence("Default URL and custom transport", "The default HTTPS health URL is passed to the custom fetch, which reaches the isolated Den successfully.",
      defaultUrl === "https://api.openworklabs.com/health" && defaultHealth.response.status === 200);

    const session = createDenClient({ baseUrl: den.ref.apiUrl, token: den.admin.token });
    const identity = await session.getV1Me({ throwOnError: true });
    expect(identity.data.user.email).toBe(den.admin.email);
    const organizations = await session.getV1MeOrgs({ throwOnError: true });
    const org = organizations.data.orgs.find((org) => org.name === "SDK integration");
    if (!org) throw new Error("The SDK did not return the integration organization.");
    const scoped = createDenClient({ baseUrl: den.ref.apiUrl, token: den.admin.token, orgId: org.id });
    // Organization creation is a hidden route, used only to prepare the second
    // membership. All context assertions below exercise the public SDK.
    const secondCreated = await denFetch(den.admin, "/v1/org", {
      method: "POST", headers: { authorization: `Bearer ${den.admin.token}` },
      body: JSON.stringify({ name: "SDK default organization" }),
    });
    expect(secondCreated.response.status).toBe(201);
    const memberships = await session.getV1MeOrgs({ throwOnError: true });
    const secondOrg = memberships.data.orgs.find((entry) => entry.name === "SDK default organization");
    if (!secondOrg) throw new Error("The SDK did not return the second organization.");
    expect(secondOrg.id).not.toBe(org.id);
    expect(memberships.data.activeOrgId).toBe(secondOrg.id);
    const selectedTeam = await scoped.postV1Teams({ name: "SDK context team" }, { throwOnError: true });
    try {
      expect(selectedTeam.data.team.organizationId).toBe(org.id);
      const defaultTeam = await session.postV1Teams({ name: "SDK context team" }, { throwOnError: true });
      try {
        expect(defaultTeam.data.team.organizationId).toBe(secondOrg.id);
        expect(defaultTeam.data.team.id).not.toBe(selectedTeam.data.team.id);
        const override = await scoped.getV1Org(undefined, {
          headers: { "x-openwork-org-id": secondOrg.id }, throwOnError: true,
        });
        expect(override.data.organization.id).toBe(secondOrg.id);
        const unchanged = await scoped.getV1Org(undefined, { throwOnError: true });
        expect(unchanged.data.organization.id).toBe(org.id);
        evidence.recordAssertionEvidence("Session organization context and request overrides", "With a different default organization, the configured orgId places a team in the selected organization. An unscoped client creates a distinct team in the default organization; a per-request override selects that organization without changing the client default.",
          selectedTeam.data.team.organizationId === org.id && defaultTeam.data.team.organizationId === secondOrg.id
          && override.data.organization.id === secondOrg.id && unchanged.data.organization.id === org.id);
      } finally {
        await session.deleteV1TeamsByTeamId({ teamId: defaultTeam.data.team.id }, { throwOnError: true });
      }
    } finally {
      await scoped.deleteV1TeamsByTeamId({ teamId: selectedTeam.data.team.id }, { throwOnError: true });
    }
    const key = await scoped.postV1ApiKeys({ createOrganizationApiKeyRequest: { name: "SDK integration" } }, { throwOnError: true });
    const requestedUrls: string[] = [];
    const keyed = createDenClient({
      baseUrl: den.ref.apiUrl, apiKey: key.data.key, orgId: org.id,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requestedUrls.push(request.url);
        return fetch(request);
      },
    });
    const keyedIdentity = await keyed.getV1Me({ throwOnError: true });
    expect(keyedIdentity.data.user.id).toBe(identity.data.user.id);
    const invalid = createDenClient({ baseUrl: den.ref.apiUrl, apiKey: "invalid-sdk-key", orgId: org.id });
    await expect(invalid.getV1Me({ throwOnError: true })).rejects.toBeDefined();
    evidence.recordAssertionEvidence("Session and API-key authentication", "Both credentials resolve to the issuing user; an invalid key rejects.",
      keyedIdentity.data.user.id === identity.data.user.id);
    const runs = await keyed.getV1WorkflowRuns({ limit: 1 }, { throwOnError: true });
    expect(runs.response.status).toBe(200);
    expect(requestedUrls).toContain(`${den.ref.apiUrl}/v1/workflow-runs?limit=1`);
    evidence.recordAssertionEvidence("Typed query parameters", "The numeric limit becomes ?limit=1 and Den accepts the request.",
      runs.response.status === 200 && requestedUrls.includes(`${den.ref.apiUrl}/v1/workflow-runs?limit=1`));

    const created = await keyed.postV1Teams({ name: "SDK team" }, { throwOnError: true });
    expect(created.data.team.name).toBe("SDK team");
    expect(created.data.team.organizationId).toBe(org.id);
    const teamId = created.data.team.id;
    try {
      const updated = await keyed.patchV1TeamsByTeamId({ teamId, name: "SDK renamed" }, { throwOnError: true });
      expect(updated.data.team.name).toBe("SDK renamed");
      expect(updated.data.team.id).toBe(teamId);
      const overridden = await keyed.patchV1TeamsByTeamId({ teamId, name: "Must not apply" }, {
        headers: { "x-api-key": "invalid-sdk-key" },
      });
      expect(overridden.response.status).toBe(401);
      expect(overridden.data).toBeUndefined();
      evidence.recordAssertionEvidence("Typed body, path, and request overrides", "A team is created in the selected org and renamed by ID; an invalid per-request key rejects the mutation.",
        created.data.team.organizationId === org.id && updated.data.team.id === teamId
        && updated.data.team.name === "SDK renamed" && overridden.response.status === 401);
    } finally {
      const removed = await keyed.deleteV1TeamsByTeamId({ teamId }, { throwOnError: true });
      expect(removed.response.status).toBe(204);
    }
    const missing = await keyed.patchV1TeamsByTeamId({ teamId, name: "Deleted" });
    expect(missing.response.status).toBe(404);
    expect(missing.data).toBeUndefined();
    evidence.recordAssertionEvidence("Deletion and error responses", "The deleted team cannot be updated: HTTP 404 and no success data.",
      missing.response.status === 404 && missing.data === undefined);
  },
);
