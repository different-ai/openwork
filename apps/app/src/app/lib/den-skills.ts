import { createDenClient, readDenSettings, writeDenSettings } from "./den";

const DEFAULT_OPENWORK_MARKETPLACE_NAME = "OpenWork Marketplace";

function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillFrontmatter(skillText: string) {
  const normalized = skillText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  const data: Record<string, string> = {};
  if (!match) return data;

  for (const line of (match[1] ?? "").split("\n")) {
    const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyValue) continue;
    const key = keyValue[1]?.trim().toLowerCase() ?? "";
    const value = stripYamlScalarQuotes(keyValue[2] ?? "");
    if (key && value) data[key] = value;
  }
  return data;
}

function fallbackSkillMetadata(skillText: string) {
  const cleanup = (value: string) => value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^description\s*:\s*/i, "")
    .trim();
  const lines = skillText.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  const name = cleanup(lines[0] ?? "") || "Untitled skill";
  const description = lines.slice(1).map(cleanup).find(Boolean) ?? null;
  return { name: name.slice(0, 255), description: description ? description.slice(0, 65535) : null };
}

function skillPluginMetadata(skillText: string) {
  const frontmatter = parseSkillFrontmatter(skillText);
  const name = (frontmatter.name ?? frontmatter.title ?? "").trim();
  if (name) {
    const description = (frontmatter.description ?? frontmatter.summary ?? "").trim();
    return {
      name: name.slice(0, 255),
      description: description ? description.slice(0, 65535) : null,
    };
  }
  return fallbackSkillMetadata(skillText);
}

export async function saveInstalledSkillToOpenWorkOrg(input: {
  skillText: string;
  shared?: "org" | "public" | null;
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

  const metadata = skillPluginMetadata(input.skillText);
  const marketplaces = await cloudClient.listOrgMarketplaces(orgId);
  const defaultMarketplace = marketplaces.find((marketplace) => marketplace.name === DEFAULT_OPENWORK_MARKETPLACE_NAME) ??
    marketplaces.find((marketplace) => marketplace.status === "active") ??
    marketplaces[0] ??
    null;
  const orgWide = input.shared === "org" || input.shared === "public";
  if (orgWide && !defaultMarketplace) {
    throw new Error("No active organization marketplace was found. Create a marketplace in OpenWork Cloud, then try again.");
  }
  const created = await cloudClient.createOrgSkillPlugin(orgId, {
    name: metadata.name,
    description: metadata.description,
    rawSourceText: input.skillText,
    orgWide,
    ...(orgWide && defaultMarketplace ? { marketplaceId: defaultMarketplace.id } : {}),
  });

  return { skillId: created.id, orgId, orgName };
}
