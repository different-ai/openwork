import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Place, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { record, rows, text } from "./org-invite.ts";

/** Network-shaped inventories exercise the real Den renderer, not SSR or browser state setters. No scale fixture is written to a customer database. */
export async function accessInventory(seed: Seed, { place }: { place: Place }, legacyRoles = false) {
  const [api, webPort] = await allocateFreePorts(2);
  const apiUrl = `http://127.0.0.1:${api}`;
  const proxy = place.kind === "local" ? await faultProxy({ apiUrl, webUrl: apiUrl }, { place }) : null;
  const den = await seed.den({ ...(proxy ? { ports: { api, web: webPort }, webApiBase: proxy.ref.webUrl } : {}), org: { name: "Access inventory workspace", members: { plain: { name: "Team Member" }, restricted: { name: "Restricted Member" }, observer: { name: "Observer Member" } } } });
  const orgId = await enableOrganizationCapabilities(seed, den.admin, { permissions: true, teamRoles: true, sharedRoles: true, memberListToolbars: true, teamAccessRows: true });
  const context = record((await seed.api(den.admin, "/v1/org")).body);
  const teamMemberId = text(rows(context.members).find((member) => record(member.user).name === "Team Member")?.id);
  const teams: { id: string; name: string }[] = [];
  for (const name of ["Editorial planning and publishing team", "Research and review team", "Operations and support team"]) {
    const result = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name, memberIds: teams.length === 0 ? [teamMemberId] : [], grantsOrganizationAdmin: teams.length === 0 }) });
    if (!result.response.ok) throw new Error(`Inventory team: HTTP ${result.response.status}`);
    teams.push({ id: text(record(record(result.body).team).id), name });
  }
  const created = await seed.api(den.admin, "/v1/permissions/sets", { method: "POST", body: JSON.stringify({ name: "Role 00000", teamIds: teams.map((team) => team.id), permissions: [] }) });
  if (!created.response.ok) throw new Error(`Inventory role: HTTP ${created.response.status}`);
  const detail = record(record(created.body).set);
  const template = { id: detail.id, name: detail.name, kind: detail.kind, allowedCount: detail.allowedCount, createdAt: detail.createdAt };
  if (legacyRoles) {
    const disabled = await seed.api(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { sharedRoles: false, teamRoles: false } }) });
    if (!disabled.response.ok) throw new Error(`Legacy role fixture: HTTP ${disabled.response.status}`);
  }
  const listed = await seed.api(den.admin, "/v1/permissions/sets");
  const defaults = rows(record(listed.body).sets).filter((set) => set.kind !== "team");
  const traffic = proxy ?? await seed.faultProxy(den);
  const faultPath = (path: string) => proxy ? path : `/api/den${path}`;
  let inventorySize = 0;
  async function inventory(count: number) {
    inventorySize = count;
    await traffic.faults.clear();
    const sets = [...defaults, ...Array.from({ length: count }, (_, index) => ({ ...template, id: index === 0 ? template.id : `pms_scale_${String(index).padStart(5, "0")}`, name: `Role ${String(index).padStart(5, "0")}`, team: index === 0 ? teams[0] : null, teams: index === 0 ? teams : [], appliesTo: { kind: "team", team: index === 0 ? teams[0] : null, teams: index === 0 ? teams : [], memberCount: 0 } }))];
    await traffic.faults.status(faultPath("/v1/permissions/sets"), 200, { times: 100, method: "GET", body: { sets } });
  }
  await inventory(0);
  const web = await seed.web({ den: proxy ? den : { ...den, ref: traffic.ref }, signedInAs: den.admin, startPath: legacyRoles ? "/dashboard/members" : "/dashboard/members?tab=roles", headless: true, viewport: { width: 1280, height: 960 } });
  return { den, web, teams, teamMemberId, traffic, faultPath, inventory,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    async failInventory() { await traffic.faults.clear(); await traffic.faults.status(faultPath("/v1/permissions/sets"), 503, { times: 1, method: "GET", body: { error: "unavailable", message: "Inventory unavailable" } }); },
    async restoreInventory() { await inventory(inventorySize); },
    async accessFailure() {
      await traffic.faults.clear();
      const path = faultPath(`/v1/teams/${teams[0].id}/plugin-access`);
      await traffic.faults.status(path, 503, { times: 1, method: "GET", body: { error: "unavailable" } });
      const base = { plugin: { id: "plg_access_fixture", name: "Shared editing tools", componentCount: 3 }, role: "manager", grantedBy: null, grantedAt: new Date().toISOString() };
      await traffic.faults.status(path, 200, { times: 100, method: "GET", body: { items: [{ ...base, edge: "direct_team", marketplace: null, grantId: "grant_access_fixture" }, { ...base, edge: "via_catalog", marketplace: { id: "marketplace_access_fixture", name: "Editorial resources and shared operations marketplace" }, grantId: null }] } });
    },
    async [Symbol.asyncDispose]() { await proxy?.[Symbol.asyncDispose](); },
  };
}

export const accessInventoryLegacy = (seed: Seed, context: { place: Place }) => accessInventory(seed, context, true);
