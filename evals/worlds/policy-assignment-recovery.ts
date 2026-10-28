import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export async function policyAssignmentRecovery(seed: Seed) {
  const den = await seed.den({
    org: { name: "Policy recovery", admin: { name: "Policy owner" }, members: { member: { name: "Policy member" } } },
  });
  await enableOrganizationCapabilities(seed, den.admin, { desktopPolicyScreenRemoval: true, teamPageTabs: true });
  const teamIds: string[] = [];
  for (const name of ["Focused audience", "Other audience"]) {
    const result = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name, memberIds: [] }) });
    const team = isRecord(result.body) && isRecord(result.body.team) ? result.body.team : null;
    if (!result.response.ok || typeof team?.id !== "string") throw new Error(`Team setup failed: ${result.response.status}`);
    teamIds.push(team.id);
  }
  const policyName = "Shared prompt policy";
  const result = await seed.api(den.admin, "/v1/desktop-policies", {
    method: "POST", body: JSON.stringify({ policyName, teamIds, roles: ["member"], priority: 17, isEnabled: true,
      policy: { allowCustomProviders: false, onboardingPrompts: ["Summarize my notes", "Draft a project update"] } }),
  });
  if (!result.response.ok) throw new Error(`Policy setup failed: ${result.response.status} ${result.text}`);
  const listed = await seed.api(den.admin, "/v1/desktop-policies");
  const before = isRecord(listed.body) ? records(listed.body.desktopPolicies).find((policy) => policy.policyName === policyName) : null;
  if (typeof before?.id !== "string") throw new Error("Missing shared policy");
  const teamPath = `/dashboard/members/teams/${teamIds[0]}?tab=desktop`;
  const web = await seed.web({ den, signedInAs: den.admin, startPath: teamPath, headless: true, viewport: { width: 1440, height: 1200 } });
  const member = den.members.member;
  if (!member) throw new Error("Missing ordinary member");
  return { den, web, member, teamIds, teamPath, policyName, policyId: before.id, before };
}
