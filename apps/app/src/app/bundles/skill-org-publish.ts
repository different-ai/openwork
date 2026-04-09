import { createDenClient, readDenSettings, writeDenSettings } from "../lib/den";

export async function saveInstalledSkillToOpenWorkOrg(input: {
  skillText: string;
  shared?: "org" | "public" | null;
  skillHubId?: string | null;
}): Promise<{ skillId: string; orgId: string; orgName: string }> {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  if (!token) {
    throw new Error("Sign in to OpenWork Cloud in Settings to share with your team.");
  }

  const cloudClient = createDenClient({ baseUrl: settings.baseUrl, token });
  let orgId = settings.activeOrgId?.trim() ?? "";
  let orgSlug = settings.activeOrgSlug?.trim() ?? "";
  let orgName = settings.activeOrgName?.trim() ?? "";

  if (!orgSlug || !orgName || !orgId) {
    const response = await cloudClient.listOrgs();
    const match = orgId
      ? response.orgs.find((org) => org.id === orgId)
      : response.orgs.find((org) => org.slug === orgSlug) ?? response.orgs[0];
    if (!match) {
      throw new Error("Choose an organization in Settings -> Cloud before sharing with your team.");
    }
    orgId = match.id;
    orgSlug = match.slug;
    orgName = match.name;
    writeDenSettings({
      ...settings,
      baseUrl: settings.baseUrl,
      authToken: token,
      activeOrgId: orgId,
      activeOrgSlug: orgSlug,
      activeOrgName: orgName,
    });
  }

  const created = await cloudClient.createOrgSkill(orgId, {
    skillText: input.skillText,
    shared: input.shared === undefined ? null : input.shared,
  });

  const hubId = input.skillHubId?.trim() ?? "";
  if (hubId) {
    await cloudClient.addOrgSkillToHub(orgId, hubId, created.id);
  }

  return { skillId: created.id, orgId, orgName };
}
