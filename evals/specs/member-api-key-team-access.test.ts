import { expect } from "vitest";
import { test, server, mcpMock } from "@openwork/testkit";
import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { connectionResponse, inventoryResponse, organizationResponse, teamResponse, requireOwnedDen } from "./member-api-key-fixture";

test("losing a team removes only the personal keys of connections the member can no longer reach", { timeout: 180_000 }, async ({ place, evidence }) => {
  requireOwnedDen();
  await using den = await server({ place, org: { name: "Personal key team access fixture", members: { bob: {} } },
    mocks: { keyed: mcpMock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [{ name: "identity_probe", description: "Synthetic member key probe", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "synthetic provider response" }] } }] }) } });
  const admin = den.admin;
  const bob = den.members.bob;
  const api = (member: typeof admin, path: string, body?: unknown, method = "POST") => denFetch(member, path, { method, headers: { authorization: `Bearer ${member.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const bobId = organizationResponse.parse((await api(admin, "/v1/org", undefined, "GET")).body).members.find((entry) => entry.user.email === bob.email)?.id;
  if (!bobId) throw new Error("Owned member absent from organization");
  const createTeam = async (name: string) => {
    const created = await api(admin, "/v1/teams", { name, memberIds: [bobId] });
    expect(created.response.status).toBe(201);
    return teamResponse.parse(created.body).team.id;
  };
  const granting = await createTeam("Granting team");
  const other = await createTeam("Other granting team");
  const unrelated = await createTeam("Unrelated team");
  const connect = async (name: string, access: unknown) => {
    const created = await api(admin, "/v1/mcp-connections", { name, url: den.mocks.keyed.mcpUrl, authType: "apikey", credentialMode: "per_member", access });
    expect(created.response.status).toBe(200);
    const id = connectionResponse.parse(created.body).id;
    expect((await api(bob, `/v1/mcp-connections/${id}/my-credential`, { apiKey: `synthetic-${name.toLowerCase().replaceAll(" ", "-")}` }, "PUT")).body).toEqual({ ok: true });
    return id;
  };
  const onlyTeam = await connect("Only team", { orgWide: false, teamIds: [granting] });
  const twoTeams = await connect("Two teams", { orgWide: false, teamIds: [granting, other] });
  const orgWide = await connect("Org wide", { orgWide: true });
  const direct = await connect("Direct grant", { orgWide: false, teamIds: [granting], memberIds: [bobId] });
  const all = [onlyTeam, twoTeams, orgWide, direct];
  const connectedForBob = async () => {
    const listed = inventoryResponse.parse((await api(bob, "/v1/mcp-connections", undefined, "GET")).body).connections;
    return Object.fromEntries(all.map((id) => [id, listed.find((entry) => entry.id === id)?.connectedForMe === true]));
  };
  const everyKey = Object.fromEntries(all.map((id) => [id, true]));
  expect(await connectedForBob()).toEqual(everyKey);

  expect((await api(admin, `/v1/teams/${unrelated}`, { memberIds: [] }, "PATCH")).response.status).toBe(200);
  expect(await connectedForBob()).toEqual(everyKey);

  expect((await api(admin, `/v1/teams/${granting}`, { memberIds: [] }, "PATCH")).response.status).toBe(200);
  expect((await api(admin, `/v1/teams/${granting}`, { memberIds: [bobId] }, "PATCH")).response.status).toBe(200);
  expect(await connectedForBob()).toEqual({ ...everyKey, [onlyTeam]: false });

  if (!den.database || !den.database.name.startsWith("openwork_eval_")) throw new Error("Member removal proof requires this test's owned isolated schema");
  const storedKeys = async () => {
    const rows = await queryDenDatabase(den.database!.url, "SELECT COUNT(*) AS total FROM connected_account WHERE org_membership_id = ? AND token_type = 'api_key'", [bobId]);
    const row = rows[0];
    if (!row || typeof row !== "object" || !("total" in row)) throw new Error("Missing key aggregate");
    return Number(row.total);
  };
  expect(await storedKeys()).toBe(3);
  expect((await api(admin, `/v1/members/${bobId}`, undefined, "DELETE")).response.status).toBe(204);
  expect(await storedKeys()).toBe(0);

  evidence.recordAssertionEvidence("Team edits keep keys the member still reaches", "Actual isolated Den: removing Bob from a team that grants nothing kept all four personal keys; removing him from the only granting team deleted only that connection's key, while access through another team, an org-wide grant or a direct member grant kept theirs.", true);
  evidence.recordAssertionEvidence("Member removal removes every personal key", "Removing Bob from the organization left zero api_key rows for his membership in the owned test schema. No key value was emitted as evidence.", true);
});
