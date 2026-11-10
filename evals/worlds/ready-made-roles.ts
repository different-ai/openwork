import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * Acme, owned by Avery, with Morgan as an admin and Riley as a member of the
 * Finance team, which has no role of its own yet. Ready-made roles start off,
 * as for every organization; `turnOnReadyMadeRoles` is the platform admin
 * turning the feature on for Acme. Avery's browser is on Members › Roles and
 * Morgan's on the same page.
 */
export async function readyMadeRolesWorld(seed: Seed) {
  const den = await seed.den({
    web: true,
    org: {
      name: "Acme",
      admin: { name: "Avery Owner" },
      members: { morgan: { name: "Morgan Admin" }, riley: { name: "Riley Finance" } },
    },
  });
  const { morgan, riley } = den.members;
  if (!morgan || !riley) throw new Error("seed.den() did not provision the member sessions");

  const context = await seed.api(den.admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  if (!context.response.ok || typeof organization?.id !== "string") throw new Error(`Reading the organization failed: ${context.text.slice(0, 500)}`);
  const organizationId = organization.id;
  const scope = { "x-openwork-org-id": organizationId };
  const members = isRecord(context.body) ? records(context.body.members) : [];
  const memberId = (name: string) => {
    const id = members.find((member) => isRecord(member.user) && member.user.name === name)?.id;
    if (typeof id !== "string") throw new Error(`${name} is not a member of the organization`);
    return id;
  };

  const promoted = await seed.api(den.admin, `/v1/members/${encodeURIComponent(memberId("Morgan Admin"))}/role`, {
    method: "POST", headers: scope, body: JSON.stringify({ role: "admin" }),
  });
  if (!promoted.response.ok) throw new Error(`Making Morgan an admin failed: HTTP ${promoted.response.status} ${promoted.text.slice(0, 300)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Finance", memberIds: [memberId("Riley Finance")] }) });
  const financeId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof financeId !== "string") throw new Error(`Setting up Finance failed: ${team.text.slice(0, 500)}`);

  const viewport = { width: 1280, height: 900 };
  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members?tab=roles", headless: true, viewport });
  const admin = await seed.web({ den, signedInAs: morgan, startPath: "/dashboard/members?tab=roles", headless: true, viewport });

  return {
    den, owner, admin, financeId,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    /** The platform admin turns Ready-made roles on for Acme in /admin. */
    async turnOnReadyMadeRoles() {
      await enableOrganizationCapabilities(seed, den.admin, { readyMadeRoles: true }, organizationId);
    },
    /** The organization's custom roles as the API lists them: id, name and how many permissions each allows. */
    async customRoles() {
      const sets = await seed.api(den.admin, "/v1/permissions/sets", { headers: scope });
      return records(isRecord(sets.body) ? sets.body.sets : []).filter((set) => set.kind === "team").map((set) => ({ id: String(set.id), name: String(set.name), allowedCount: Number(set.allowedCount) }));
    },
    /** What Riley can do right now, as Den resolves it. */
    async rileyPermissions() {
      const org = await seed.api(riley, "/v1/org");
      const member = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
      return Array.isArray(member?.permissions) ? member.permissions.filter((key): key is string => typeof key === "string") : [];
    },
  };
}
