import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Place, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { record, text } from "./org-invite.ts";

export async function accessDrafts(seed: Seed, { place }: { place: Place }) {
  const [api, webPort] = await allocateFreePorts(2);
  const apiUrl = `http://127.0.0.1:${api}`;
  const proxy = place.kind === "local" ? await faultProxy({ apiUrl, webUrl: apiUrl }, { place }) : null;
  const den = await seed.den({ ...(proxy ? { ports: { api, web: webPort }, webApiBase: proxy.ref.webUrl } : {}), org: { name: "Draft workspace", members: { plain: { name: "Plain Member" } } } });
  const orgId = await enableOrganizationCapabilities(seed, den.admin, { permissions: true, teamRoles: true, sharedRoles: true, agentPermissions: true, teamPageTabs: true });
  async function create(path: string, body: unknown) {
    const result = await seed.api(den.admin, path, { method: "POST", body: JSON.stringify(body) });
    if (!result.response.ok) throw new Error(`Draft world ${path}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    return record(result.body);
  }
  const team = text(record((await create("/v1/teams", { name: "Editors", memberIds: [] })).team).id);
  const other = text(record((await create("/v1/teams", { name: "Other team", memberIds: [] })).team).id);
  const role = text(record((await create("/v1/permissions/sets", { name: "Editor role", teamIds: [team], permissions: [] })).set).id);
  const traffic = proxy ?? await seed.faultProxy(den);
  const web = await seed.web({ den: proxy ? den : { ...den, ref: traffic.ref }, signedInAs: den.admin, startPath: `/dashboard/members/teams/${team}?tab=agents`, headless: true, viewport: { width: 1280, height: 960 } });
  return { den, web, orgId, team, other, role, traffic,
    faultPath: (path: string) => proxy ? path : `/api/den${path}`,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    async [Symbol.asyncDispose]() { await proxy?.[Symbol.asyncDispose](); },
  };
}
