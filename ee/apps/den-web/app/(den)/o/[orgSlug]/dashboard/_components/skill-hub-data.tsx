"use client";

import { useEffect, useState } from "react";
import { composeSkillMarkdown, parseSkillMarkdown } from "@openwork-ee/utils";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";

export type DenSkillShared = "org" | "public" | null;

export type DenSkill = {
  id: string;
  organizationId: string;
  createdByOrgMembershipId: string;
  title: string;
  description: string | null;
  skillText: string;
  shared: DenSkillShared;
  createdAt: string | null;
  updatedAt: string | null;
  canManage: boolean;
};

export type DenSkillHubMemberAccess = {
  id: string;
  orgMembershipId: string;
  role: string;
  createdAt: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  };
};

export type DenSkillHubTeamAccess = {
  id: string;
  teamId: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DenSkillHub = {
  id: string;
  organizationId: string;
  createdByOrgMembershipId: string;
  name: string;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  canManage: boolean;
  accessibleVia: {
    orgMembershipIds: string[];
    teamIds: string[];
  };
  skills: DenSkill[];
  access: {
    members: DenSkillHubMemberAccess[];
    teams: DenSkillHubTeamAccess[];
  };
};

export type SkillComposerDraft = {
  name: string;
  description: string;
  category: string;
  details: string;
};

export const skillCategoryOptions = [
  "Engineering",
  "Workflow",
  "Marketing",
  "Operations",
  "Sales",
  "Support",
  "General",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIsoString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asSkill(value: unknown): DenSkill | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  const organizationId = asString(value.organizationId);
  const createdByOrgMembershipId = asString(value.createdByOrgMembershipId);
  const title = asString(value.title);
  if (!id || !organizationId || !createdByOrgMembershipId || !title) {
    return null;
  }

  const sharedValue = value.shared;
  const shared: DenSkillShared = sharedValue === "org" || sharedValue === "public" ? sharedValue : null;

  return {
    id,
    organizationId,
    createdByOrgMembershipId,
    title,
    description: asString(value.description),
    skillText: asString(value.skillText) ?? "",
    shared,
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
    canManage: value.canManage === true,
  };
}

function asSkillHubMemberAccess(value: unknown): DenSkillHubMemberAccess | null {
  if (!isRecord(value) || !isRecord(value.user)) {
    return null;
  }

  const id = asString(value.id);
  const orgMembershipId = asString(value.orgMembershipId);
  const role = asString(value.role);
  const user = value.user;
  const userId = asString(user.id);
  const name = asString(user.name);
  const email = asString(user.email);
  if (!id || !orgMembershipId || !role || !userId || !name || !email) {
    return null;
  }

  return {
    id,
    orgMembershipId,
    role,
    createdAt: asIsoString(value.createdAt),
    user: {
      id: userId,
      name,
      email,
      image: asString(user.image),
    },
  };
}

function asSkillHubTeamAccess(value: unknown): DenSkillHubTeamAccess | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  const teamId = asString(value.teamId);
  const name = asString(value.name);
  if (!id || !teamId || !name) {
    return null;
  }

  return {
    id,
    teamId,
    name,
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
  };
}

function asSkillHub(value: unknown): DenSkillHub | null {
  if (!isRecord(value) || !isRecord(value.access) || !isRecord(value.accessibleVia)) {
    return null;
  }

  const id = asString(value.id);
  const organizationId = asString(value.organizationId);
  const createdByOrgMembershipId = asString(value.createdByOrgMembershipId);
  const name = asString(value.name);
  if (!id || !organizationId || !createdByOrgMembershipId || !name) {
    return null;
  }

  const access = value.access;
  const accessibleVia = value.accessibleVia;

  return {
    id,
    organizationId,
    createdByOrgMembershipId,
    name,
    description: asString(value.description),
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
    canManage: value.canManage === true,
    accessibleVia: {
      orgMembershipIds: asStringList(accessibleVia.orgMembershipIds),
      teamIds: asStringList(accessibleVia.teamIds),
    },
    skills: Array.isArray(value.skills) ? value.skills.map(asSkill).filter((entry): entry is DenSkill => entry !== null) : [],
    access: {
      members: Array.isArray(access.members)
        ? access.members.map(asSkillHubMemberAccess).filter((entry): entry is DenSkillHubMemberAccess => entry !== null)
        : [],
      teams: Array.isArray(access.teams)
        ? access.teams.map(asSkillHubTeamAccess).filter((entry): entry is DenSkillHubTeamAccess => entry !== null)
        : [],
    },
  };
}

export function parseSkillCategory(skillText: string): string | null {
  const match = skillText.match(/^category\s*:\s*(.+)$/im);
  return match && match[1] ? match[1].trim() : null;
}

export function parseSkillDraft(skillText: string, fallback?: { name?: string | null; description?: string | null }): SkillComposerDraft {
  const parsed = parseSkillMarkdown(skillText);
  if (parsed.hasFrontmatter) {
    return {
      name: parsed.name || fallback?.name || "",
      description: parsed.description || fallback?.description || "",
      category: parseSkillCategory(skillText) ?? "General",
      details: parsed.body.trim(),
    };
  }

  const lines = skillText.split(/\r?\n/g);
  const nonEmptyIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (line.trim()) {
      indexes.push(index);
    }
    return indexes;
  }, []);

  const titleIndex = nonEmptyIndexes[0] ?? -1;
  const descriptionIndex = nonEmptyIndexes[1] ?? -1;
  const categoryIndex = nonEmptyIndexes.find((index) => /^category\s*:/i.test(lines[index]?.trim() ?? "")) ?? -1;

  const bodyStartIndex = categoryIndex >= 0
    ? categoryIndex + 1
    : descriptionIndex >= 0
      ? descriptionIndex + 1
      : titleIndex >= 0
        ? titleIndex + 1
        : 0;

  const titleLine = titleIndex >= 0 ? lines[titleIndex] : fallback?.name ?? "";
  const descriptionLine = descriptionIndex >= 0 ? lines[descriptionIndex] : fallback?.description ?? "";

  return {
    name: cleanupSkillMetadataLine(titleLine) || fallback?.name || "",
    description: cleanupSkillMetadataLine(descriptionLine) || fallback?.description || "",
    category: categoryIndex >= 0 ? lines[categoryIndex].replace(/^category\s*:/i, "").trim() : parseSkillCategory(skillText) ?? "General",
    details: lines.slice(bodyStartIndex).join("\n").trim(),
  };
}

export function getSkillBodyText(skillText: string, fallback?: { name?: string | null; description?: string | null }) {
  const parsed = parseSkillMarkdown(skillText);
  if (parsed.hasFrontmatter) {
    return parsed.body.trim();
  }

  const draft = parseSkillDraft(skillText, fallback);
  return draft.details || skillText;
}

export function getSkillBodyPreview(skillText: string, fallback?: { name?: string | null; description?: string | null }) {
  const body = getSkillBodyText(skillText, fallback)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .trim();

  if (!body) {
    return null;
  }

  const firstParagraph = body
    .split(/\n\s*\n/g)
    .map((section) => section.trim())
    .find(Boolean);

  return firstParagraph ?? null;
}

function cleanupSkillMetadataLine(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^description\s*:\s*/i, "")
    .trim();
}

export function buildSkillText(input: SkillComposerDraft): string {
  return composeSkillMarkdown(input.name, input.description, input.details);
}

export function getSkillVisibilityLabel(shared: DenSkillShared): string {
  if (shared === "org") {
    return "Org";
  }
  if (shared === "public") {
    return "Public";
  }
  return "Private";
}

export function formatSkillTimestamp(value: string | null) {
  if (!value) {
    return "Recently updated";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently updated";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function getHubAccent(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 33 + seed.charCodeAt(index)) % 360;
  }

  const hue = hash;
  const gradient = `radial-gradient(circle at 18% 18%, hsla(${(hue + 18) % 360} 92% 92% / 0.95) 0%, transparent 38%), linear-gradient(135deg, hsl(${hue} 85% 78%) 0%, hsl(${(hue + 32) % 360} 92% 86%) 48%, hsl(${(hue + 86) % 360} 78% 86%) 100%)`;

  return {
    gradient,
    grain: `radial-gradient(circle at 20% 20%, rgba(255,255,255,0.65) 0%, rgba(255,255,255,0) 45%), radial-gradient(circle at 80% 30%, rgba(255,255,255,0.48) 0%, rgba(255,255,255,0) 35%), radial-gradient(circle at 55% 78%, rgba(15,23,42,0.08) 0%, rgba(15,23,42,0) 42%)`,
  };
}

export function useOrgSkillLibrary(orgId: string | null) {
  const [skills, setSkills] = useState<DenSkill[]>([]);
  const [skillHubs, setSkillHubs] = useState<DenSkillHub[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadLibrary() {
    if (!orgId) {
      setSkills([]);
      setSkillHubs([]);
      setError("Organization not found.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const [skillsResult, skillHubsResult] = await Promise.all([
        requestJson(`/v1/orgs/${encodeURIComponent(orgId)}/skills`, { method: "GET" }, 12000),
        requestJson(`/v1/orgs/${encodeURIComponent(orgId)}/skill-hubs`, { method: "GET" }, 12000),
      ]);

      if (!skillsResult.response.ok) {
        throw new Error(getErrorMessage(skillsResult.payload, `Failed to load skills (${skillsResult.response.status}).`));
      }

      if (!skillHubsResult.response.ok) {
        throw new Error(getErrorMessage(skillHubsResult.payload, `Failed to load skill hubs (${skillHubsResult.response.status}).`));
      }

      const nextSkills = isRecord(skillsResult.payload) && Array.isArray(skillsResult.payload.skills)
        ? skillsResult.payload.skills.map(asSkill).filter((entry): entry is DenSkill => entry !== null)
        : [];
      const nextSkillHubs = isRecord(skillHubsResult.payload) && Array.isArray(skillHubsResult.payload.skillHubs)
        ? skillHubsResult.payload.skillHubs.map(asSkillHub).filter((entry): entry is DenSkillHub => entry !== null)
        : [];

      setSkills(nextSkills);
      setSkillHubs(nextSkillHubs);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the skill library.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadLibrary();
  }, [orgId]);

  return {
    skills,
    skillHubs,
    busy,
    error,
    reloadLibrary: loadLibrary,
  };
}
