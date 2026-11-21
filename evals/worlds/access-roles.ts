import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Place, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { record, rows, text } from "./org-invite.ts";

async function accessRoles(seed: Seed, { place }: { place: Place }, lookupFailure: boolean) {
  const [api, webPort] = await allocateFreePorts(2);
  const apiUrl = `http://127.0.0.1:${api}`;
  const proxy = place.kind === "local" ? await faultProxy({ apiUrl, webUrl: apiUrl }, { place }) : null;
  const den = await seed.den({
    ...(proxy ? { ports: { api, web: webPort }, webApiBase: proxy.ref.webUrl } : {}),
    org: { name: "Access workspace", members: { target: { name: "Direct Admin" }, plain: { name: "Plain Member" } } },
  });
  const orgId = await enableOrganizationCapabilities(seed, den.admin, { permissions: true, teamRoles: true, sharedRoles: true, memberListToolbars: true });
  const context = await seed.api(den.admin, "/v1/org");
  const target = rows(record(context.body).members).find((entry) => record(entry.user).name === "Direct Admin");
  const targetId = text(target?.id);
  async function arrange(path: string, method: "POST" | "PUT", body: unknown) {
    const result = await seed.api(den.admin, path, { method, body: JSON.stringify(body) });
    if (!result.response.ok) throw new Error(`Access world ${path}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    return record(result.body);
  }
  await arrange(`/v1/members/${targetId}/role`, "POST", { role: "admin" });
  const alpha = text(record((await arrange("/v1/teams", "POST", { name: "Alpha team", memberIds: [], grantsOrganizationAdmin: true })).team).id);
  const beta = text(record((await arrange("/v1/teams", "POST", { name: "Beta team", memberIds: [] })).team).id);
  const previous = text(record((await arrange("/v1/permissions/sets", "POST", { name: "Previous role", teamIds: [beta], permissions: [] })).set).id);
  const publisher = text(record((await arrange("/v1/permissions/sets", "POST", { name: "Publisher role", permissions: [{ key: "teams.view", status: "allow" }] })).set).id);
  const traffic = proxy ?? await seed.faultProxy(den);
  const faultPath = (path: string) => proxy ? path : `/api/den${path}`;
  if (lookupFailure) await traffic.faults.status(faultPath("/v1/permissions/sets"), 503, { times: 1, method: "GET", body: { error: "unavailable", message: "Role lookup unavailable" } });
  const startPath = lookupFailure ? `/dashboard/members/teams/${beta}` : "/dashboard/members";
  const web = await seed.web({ den: proxy ? den : { ...den, ref: traffic.ref }, signedInAs: den.admin, startPath, headless: true, viewport: { width: 1280, height: 900 } });
  return { den, web, orgId, alpha, beta, publisher, previous, targetId, traffic, faultPath,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    async [Symbol.asyncDispose]() { await proxy?.[Symbol.asyncDispose](); },
  };
}

export const accessRolesWorld = (seed: Seed, context: { place: Place }) => accessRoles(seed, context, false);
export const accessRoleLookupFailure = (seed: Seed, context: { place: Place }) => accessRoles(seed, context, true);
