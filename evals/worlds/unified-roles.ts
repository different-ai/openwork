import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/**
 * Acme, owned by Avery, with Morgan as an admin, Riley in the Finance team
 * (which has no role of its own yet) and Casey in no team. Nobody holds
 * Billing manager. Avery's browser is on Members › Roles and Morgan's on the
 * same page.
 */
export async function unifiedRolesWorld(seed: Seed) {
  const den = await seed.den({
    web: true,
    org: {
      name: "Acme",
      admin: { name: "Avery Owner" },
      members: { morgan: { name: "Morgan Admin" }, riley: { name: "Riley Finance" }, casey: { name: "Casey Accounts" } },
    },
  });
  const { morgan } = den.members;
  if (!morgan) throw new Error("seed.den() did not provision the member sessions");

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
  const rileyId = memberId("Riley Finance");
  const caseyId = memberId("Casey Accounts");

  const promoted = await seed.api(den.admin, `/v1/members/${encodeURIComponent(memberId("Morgan Admin"))}/role`, {
    method: "POST", headers: scope, body: JSON.stringify({ role: "admin" }),
  });
  if (!promoted.response.ok) throw new Error(`Making Morgan an admin failed: HTTP ${promoted.response.status} ${promoted.text.slice(0, 300)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Finance", memberIds: [rileyId] }) });
  const financeId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof financeId !== "string") throw new Error(`Setting up Finance failed: ${team.text.slice(0, 500)}`);

  const viewport = { width: 1280, height: 900 };
  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members?tab=roles", headless: true, viewport });
  const admin = await seed.web({ den, signedInAs: morgan, startPath: "/dashboard/members?tab=roles", headless: true, viewport });

  /**
   * A person's organization role and what they can do right now, as Den
   * resolves it for the owner. Read as the owner because lowering someone's
   * role signs them out.
   */
  async function access(id: string) {
    const roster = await seed.api(den.admin, "/v1/org");
    const member = (isRecord(roster.body) ? records(roster.body.members) : []).find((entry) => entry.id === id);
    const explained = await seed.api(den.admin, `/v1/members/${encodeURIComponent(id)}/permissions`, { headers: scope });
    if (!explained.response.ok) throw new Error(`Reading the person's permissions failed: HTTP ${explained.response.status} ${explained.text.slice(0, 300)}`);
    return {
      role: typeof member?.role === "string" ? member.role : "",
      permissions: records(isRecord(explained.body) ? explained.body.permissions : []).flatMap((entry) => typeof entry.key === "string" ? [entry.key] : []),
    };
  }

  return {
    den, owner, admin, financeId, rileyId, caseyId,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    /** The built-in Billing manager role as the API lists it: its set, the people given it directly and its teams. */
    async billingManager() {
      const sets = await seed.api(den.admin, "/v1/permissions/sets", { headers: scope });
      const set = records(isRecord(sets.body) ? sets.body.sets : []).find((entry) => entry.kind === "billing_manager_default");
      if (!set) throw new Error(`The organization has no Billing manager role: ${sets.text.slice(0, 300)}`);
      return {
        id: String(set.id),
        allowedCount: Number(set.allowedCount),
        memberIds: Array.isArray(set.directMemberIds) ? set.directMemberIds.map(String) : [],
        teams: records(set.teams).map((entry) => ({ id: String(entry.id), name: String(entry.name) })),
      };
    },
    /** The organization's custom roles as the API lists them. */
    async customRoles() {
      const sets = await seed.api(den.admin, "/v1/permissions/sets", { headers: scope });
      return records(isRecord(sets.body) ? sets.body.sets : []).filter((set) => set.kind === "team").map((set) => String(set.name));
    },
    /** A pending or joined member's id by email, as the owner's roster lists it. */
    async memberIdByEmail(email: string) {
      const roster = await seed.api(den.admin, "/v1/org");
      const found = (isRecord(roster.body) ? records(roster.body.members) : []).find((member) => isRecord(member.user) && member.user.email === email);
      return typeof found?.id === "string" ? found.id : null;
    },
    /** Riley's organization role and what Riley can do right now. */
    riley: () => access(rileyId),
    /** Casey's organization role and what Casey can do right now. */
    casey: () => access(caseyId),
  };
}
