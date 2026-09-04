import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/**
 * The organization's default desktop policy as Den returns it, with the shape
 * checks a spec needs before comparing saved values.
 */
export async function readDefaultDesktopPolicy(
  channel: Pick<Seed, "api">,
  admin: Parameters<Seed["api"]>[0],
): Promise<Record<string, unknown>> {
  const result = await channel.api(admin, "/v1/desktop-policies");
  const policies = isRecord(result.body) ? records(result.body.desktopPolicies) : [];
  const policy = policies.find((entry) => entry.isDefault === true);
  if (!result.response.ok || !policy || typeof policy.id !== "string") {
    throw new Error(`Reading the default desktop policy failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return policy;
}

/**
 * One organization whose default desktop policy is still Custom, a member
 * signed in to a fresh desktop, and the admin signed in to that policy's Den
 * Web editor. Only Den and the member desktop are placed; the admin browser
 * shares the Den's placement so Den Web is reached over loopback.
 */
export async function defaultPolicyEditorAndMemberDesktop(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: {
      name: `Restricted Policy ${stamp}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" } },
    },
  });
  if (!den.members.jordan) throw new Error("seed.den() did not provision the jordan member session");

  const policyBefore = await readDefaultDesktopPolicy(seed, den.admin);
  const policyId = String(policyBefore.id);
  const editorPath = `/dashboard/desktop-policies/${encodeURIComponent(policyId)}`;

  const member = await seed.desktop({ den, as: "jordan" });
  const admin = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: editorPath,
    headless: true,
    // Tall enough that the whole capability list, through the editable
    // Welcome Page row, stays inside the frame the vision judge sees.
    viewport: { width: 1440, height: 2100 },
  });

  return { den, member, admin, policyId, editorPath };
}

/** Two ordinary members share defaults that block Alpha updates. Jordan gets
 * Alpha access only from the overlapping grant team and belongs to both the
 * focused team and an overlapping grant team; Casey is the unaffected control.
 * The admin starts at Team Access and Jordan starts in a real desktop. */
export async function teamAccess(seed: Seed) {
  const den = await seed.den({
    org: {
      name: `Team Access ${Date.now()}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" }, casey: { name: "Casey Eval" } },
    },
  });
  if (!den.members.jordan || !den.members.casey) throw new Error("Missing ordinary member sessions");
  const flags = {
    allowCustomProviders: true, allowZenModel: true, allowMultipleWorkspaces: true,
    allowControlSettings: true, allowManageExtensions: true, allowBuiltInExtensions: true,
    allowAlphaUpdates: true, showWelcomePage: true,
  };
  const initial = await readDefaultDesktopPolicy(seed, den.admin);
  const reset = await seed.api(den.admin, `/v1/desktop-policies/${initial.id}`, {
    method: "PATCH", body: JSON.stringify({ policyName: "Default desktop policy", policy: { ...flags, allowAlphaUpdates: false } }),
  });
  if (!reset.response.ok) throw new Error(`Default grants failed: ${reset.text}`);
  const org = await seed.api(den.members.jordan, "/v1/org");
  const currentMember = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof currentMember?.id !== "string") throw new Error("Missing target member ID");
  async function createTeam(name: string) {
    const result = await seed.api(den.admin, "/v1/teams", {
      method: "POST", body: JSON.stringify({ name, memberIds: [currentMember?.id] }),
    });
    const team = isRecord(result.body) && isRecord(result.body.team) ? result.body.team : null;
    if (!result.response.ok || typeof team?.id !== "string") throw new Error(`Team setup failed: ${result.text}`);
    return team.id;
  }
  const teamId = await createTeam("Focused work");
  const grantTeamId = await createTeam("Additional tools");
  const grant = await seed.api(den.admin, "/v1/desktop-policies", {
    method: "POST", body: JSON.stringify({ policyName: "Additional team grants", policy: flags, teamIds: [grantTeamId] }),
  });
  if (!grant.response.ok) throw new Error(`Overlapping grant failed: ${grant.text}`);
  const pluginName = "Approved briefing";
  const rawSourceText = "---\nname: approved-briefing\ndescription: An approved team briefing skill.\n---\nSummarize the supplied notes into decisions and next steps. Team access proof.";
  const plugin = await seed.api(den.admin, "/v1/plugins", {
    method: "POST", body: JSON.stringify({ name: pluginName, components: [{ type: "skill", input: { rawSourceText } }] }),
  });
  const item = isRecord(plugin.body) && isRecord(plugin.body.item) ? plugin.body.item : null;
  if (!plugin.response.ok || typeof item?.id !== "string") throw new Error(`Approved skill setup failed: ${plugin.text}`);
  const pluginId = item.id;
  const shared = await seed.api(den.admin, `/v1/plugins/${pluginId}/access`, {
    method: "POST", body: JSON.stringify({ teamId, role: "viewer" }),
  });
  if (!shared.response.ok) throw new Error(`Approved skill sharing failed: ${shared.text}`);
  const editorPath = `/dashboard/members/teams/${teamId}`;
  const member = await seed.desktop({ den, as: "jordan" });
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: editorPath, headless: true, viewport: { width: 1440, height: 2100 } });
  return { den, member, admin, teamId, grantTeamId, editorPath, pluginId, pluginName, rawSourceText };
}
