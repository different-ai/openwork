import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord, records } from "./library.ts";

/** OpenCode permission rules, as the Permissions screens save them. */
export type TeamRule = { action: "shell" | "webfetch" | "skill" | "mcp"; resource: string; effect: "allow" | "deny" };

/**
 * An organization with Permissions on and two ordinary members: Riley is in
 * the Contractors team, which has its own permission set; Morgan is in no team
 * and is the unaffected control. Permission rules start off for the
 * organization, as on a fresh deployment.
 */
export function teamRules(seed: Seed) {
  return teamRulesOrganization(seed, { web: false });
}

async function teamRulesOrganization(seed: Seed, { web, trustedOrigins }: { web: boolean; trustedOrigins?: string[] }) {
  const stamp = Date.now().toString(36);
  const den = await seed.den({
    web,
    schema: "migrate",
    env: { DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    ...(trustedOrigins ? { trustedOrigins } : {}),
    org: {
      name: `Team Rules ${stamp}`,
      admin: { name: "Avery Owner" },
      members: { riley: { name: "Riley Contractor" }, morgan: { name: "Morgan Staff" } },
    },
  });
  const riley = den.members.riley;
  const morgan = den.members.morgan;
  if (!riley || !morgan) throw new Error("seed.den() did not provision the member sessions");

  const org = await seed.api(riley, "/v1/org");
  const rileyMember = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof rileyMember?.id !== "string") throw new Error(`Reading Riley's membership failed: ${org.text.slice(0, 500)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name: "Contractors", memberIds: [rileyMember.id] }) });
  const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof teamId !== "string") throw new Error(`Team setup failed: ${team.text.slice(0, 500)}`);

  await enableOrganizationCapabilities(seed, den.admin, { permissions: true });
  const created = await seed.api(den.admin, "/v1/permissions/sets", { method: "POST", body: JSON.stringify({ teamId, permissions: [] }) });
  const contractorsSetId = isRecord(created.body) && isRecord(created.body.set) ? created.body.set.id : null;
  if (!created.response.ok || typeof contractorsSetId !== "string") throw new Error(`Team permissions setup failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  const sets = await seed.api(den.admin, "/v1/permissions/sets");
  const memberSetId = isRecord(sets.body) ? records(sets.body.sets).find((set) => set.kind === "member_default")?.id : null;
  if (typeof memberSetId !== "string") throw new Error("Missing the Member permissions set");

  /** Saves each action's rules on a set, as the Rules tab does; actions left out are cleared. */
  async function saveRules(setId: string, rules: TeamRule[], as = den.admin) {
    let status = 200;
    for (const action of ["shell", "webfetch", "skill", "mcp"] as const) {
      const saved = await seed.api(as, `/v1/permissions/sets/${encodeURIComponent(setId)}/rules`, {
        method: "PUT",
        body: JSON.stringify({ action, rules: rules.filter((rule) => rule.action === action).map(({ resource, effect }) => ({ resource, effect })) }),
      });
      if (as === den.admin && !saved.response.ok) throw new Error(`Saving ${action} rules failed: HTTP ${saved.response.status} ${saved.text.slice(0, 500)}`);
      status = saved.response.status;
    }
    return status;
  }

  return {
    den,
    teamId,
    contractorsSetId,
    saveTeamRules: (rules: TeamRule[]) => saveRules(contractorsSetId, rules),
    saveMemberRules: (rules: TeamRule[]) => saveRules(memberSetId, rules),
    /** Riley trying to change the Contractors rules through the API. */
    memberSaveStatus: () => saveRules(contractorsSetId, [], riley),
    enableTeamRules: () => enableOrganizationCapabilities(seed, den.admin, { permissionRules: true }),
    /** The rules a member's desktop app and OpenWork Web receive, in the order they apply. */
    async receivedRules(member: "riley" | "morgan") {
      const config = await seed.api(member === "riley" ? riley : morgan, "/v1/me/desktop-config");
      if (!config.response.ok || !isRecord(config.body)) throw new Error(`Reading desktop config failed: HTTP ${config.response.status}`);
      return records(config.body.rules);
    },
  };
}
