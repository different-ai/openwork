import { createDenClient, readDenSettings, writeDenSettings } from "./den";

const DEFAULT_OPENWORK_MARKETPLACE_NAME = "OpenWork Marketplace";

export type CloudSkillMoveResult = {
  skillId: string;
  orgId: string;
  orgName: string;
  operation: "created" | "updated";
};

export class CloudSkillMoveCleanupError extends Error {
  readonly cloudResult: CloudSkillMoveResult;

  constructor(cloudResult: CloudSkillMoveResult, cause: unknown) {
    const detail = cause instanceof Error && cause.message.trim()
      ? ` ${cause.message.trim()}`
      : "";
    super(
      `The skill was saved in OpenWork Cloud, but its local copy could not be removed.${detail} ` +
      "It currently exists in both places; retry the move or remove the local copy manually.",
      { cause },
    );
    this.name = "CloudSkillMoveCleanupError";
    this.cloudResult = cloudResult;
  }
}

function stripScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
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
    const value = stripScalarQuotes(keyValue[2] ?? "");
    if (key && value) data[key] = value;
  }
  return data;
}

function skillPluginMetadata(skillText: string) {
  const frontmatter = parseSkillFrontmatter(skillText);
  const name = (frontmatter.name ?? "").trim();
  if (!name) {
    throw new Error("SKILL.md frontmatter requires a non-empty name before it can be moved to OpenWork Cloud.");
  }
  const description = (frontmatter.description ?? "").trim();
  return {
    name,
    description: description || null,
  };
}

async function resolveActiveOrganization() {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  if (!token) {
    throw new Error("Sign in to OpenWork Cloud in Settings before moving this skill.");
  }

  const cloudClient = createDenClient({ baseUrl: settings.baseUrl, token });
  let orgId = settings.activeOrgId?.trim() ?? "";
  let orgSlug = settings.activeOrgSlug?.trim() ?? "";
  let orgName = settings.activeOrgName?.trim() ?? "";

  if (!orgId || !orgSlug || !orgName) {
    const response = await cloudClient.listOrgs();
    const match = orgId
      ? response.orgs.find((org) => org.id === orgId)
      : response.orgs.find((org) => org.slug === orgSlug) ?? response.orgs[0];
    if (!match) {
      throw new Error("Choose an organization in Settings → Cloud before moving this skill.");
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

  return { cloudClient, orgId, orgName };
}

export async function saveInstalledSkillToOpenWorkOrg(input: {
  skillText: string;
  removeLocalSkill: () => void | Promise<void>;
  shared?: "org" | "public" | null;
}): Promise<CloudSkillMoveResult> {
  const metadata = skillPluginMetadata(input.skillText);
  const { cloudClient, orgId, orgName } = await resolveActiveOrganization();
  const candidates = await cloudClient.listOrgSkillConfigObjects(orgId, metadata.name);
  const exactMatches = candidates.filter(
    (candidate) => candidate.title.trim().toLowerCase() === metadata.name.toLowerCase(),
  );

  if (exactMatches.length > 1) {
    throw new Error(
      `More than one OpenWork Cloud skill is named "${metadata.name}". ` +
      "Resolve the duplicate Cloud skills before moving the local copy.",
    );
  }

  let cloudResult: CloudSkillMoveResult;
  const existing = exactMatches[0];
  if (existing) {
    const updated = await cloudClient.createOrgSkillConfigObjectVersion(
      orgId,
      existing.id,
      input.skillText,
    );
    cloudResult = {
      skillId: updated.id,
      orgId,
      orgName,
      operation: "updated",
    };
  } else {
    const orgWide = input.shared === "org" || input.shared === "public";
    const marketplaces = orgWide ? await cloudClient.listOrgMarketplaces(orgId) : [];
    const defaultMarketplace = marketplaces.find(
      (marketplace) => marketplace.name === DEFAULT_OPENWORK_MARKETPLACE_NAME,
    ) ?? marketplaces.find((marketplace) => marketplace.status === "active") ?? marketplaces[0] ?? null;
    if (orgWide && !defaultMarketplace) {
      throw new Error(
        "No active organization marketplace was found. Create a marketplace in OpenWork Cloud, then try again.",
      );
    }

    const created = await cloudClient.createOrgSkillPlugin(orgId, {
      name: metadata.name,
      description: metadata.description,
      rawSourceText: input.skillText,
      orgWide,
      ...(orgWide && defaultMarketplace ? { marketplaceId: defaultMarketplace.id } : {}),
    });
    cloudResult = {
      skillId: created.id,
      orgId,
      orgName,
      operation: "created",
    };
  }

  try {
    await input.removeLocalSkill();
  } catch (error) {
    throw new CloudSkillMoveCleanupError(cloudResult, error);
  }

  return cloudResult;
}
