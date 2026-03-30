import type { WorkspacePreset } from "../types";
import type {
  BundleImportSummary,
  BundleV1,
  SkillBundleItem,
  WorkspaceProfileBundleV1,
} from "./types";
import type { OpenworkWorkspaceExport } from "../lib/openwork-server";

type PortableFileItem = {
  path: string;
  content: string;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSkillItem(value: unknown): SkillBundleItem | null {
  const record = readRecord(value);
  if (!record) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!name || !content) return null;
  return {
    name,
    description: typeof record.description === "string" ? record.description : undefined,
    trigger: typeof record.trigger === "string" ? record.trigger : undefined,
    content,
  };
}

function readPortableFileItem(value: unknown): PortableFileItem | null {
  const record = readRecord(value);
  if (!record) return null;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!path) return null;
  return { path, content };
}

function readWorkspacePreset(value: unknown): WorkspacePreset {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "automation" || normalized === "minimal") {
    return normalized;
  }
  return "starter";
}

export function defaultPresetFromWorkspaceProfileBundle(bundle: WorkspaceProfileBundleV1): WorkspacePreset {
  const openwork = bundle.workspace?.openwork;
  if (!openwork || typeof openwork !== "object") return "starter";
  const workspace = (openwork as Record<string, unknown>).workspace;
  if (!workspace || typeof workspace !== "object") return "starter";
  return readWorkspacePreset((workspace as Record<string, unknown>).preset);
}

function describeWorkspaceProfileItems(bundle: WorkspaceProfileBundleV1): string[] {
  const workspace = bundle.workspace;
  const skills = Array.isArray(workspace.skills)
    ? workspace.skills
        .map((skill) => (skill && typeof skill === "object" && typeof (skill as { name?: unknown }).name === "string"
          ? (skill as { name: string }).name.trim()
          : ""))
        .filter(Boolean)
    : [];
  const commands = Array.isArray(workspace.commands) ? workspace.commands.length : 0;
  const files = Array.isArray(workspace.files) ? workspace.files.length : 0;
  const hasOpenCodeConfig = Boolean(workspace.opencode && typeof workspace.opencode === "object");
  const hasOpenWorkConfig = Boolean(workspace.openwork && typeof workspace.openwork === "object");

  return [
    ...skills,
    ...(commands > 0 ? [`${commands} command${commands === 1 ? "" : "s"}`] : []),
    ...(hasOpenCodeConfig ? ["OpenCode config"] : []),
    ...(hasOpenWorkConfig ? ["OpenWork config"] : []),
    ...(files > 0 ? [`${files} portable file${files === 1 ? "" : "s"}`] : []),
  ];
}

export function describeBundleImport(bundle: BundleV1): BundleImportSummary {
  if (bundle.type === "skill") {
    return {
      title: "Import 1 skill",
      description: bundle.description?.trim() || `Add \`${bundle.name}\` to an existing worker or create a new one for it.`,
      items: [bundle.name],
    };
  }

  if (bundle.type === "skills-set") {
    const count = bundle.skills.length;
    return {
      title: `Import ${count} skill${count === 1 ? "" : "s"}`,
      description:
        bundle.description?.trim() ||
        `${bundle.name || "Shared skills"} is ready to import into an existing worker or a new worker.`,
      items: bundle.skills.map((skill) => skill.name),
    };
  }

  return {
    title: bundle.name?.trim() || "Open workspace bundle",
    description:
      bundle.description?.trim() ||
      `${bundle.name || "This workspace bundle"} is ready to start in a new worker or import into an existing one.`,
    items: describeWorkspaceProfileItems(bundle),
  };
}

export function parseBundlePayload(value: unknown): BundleV1 {
  const record = readRecord(value);
  if (!record) {
    throw new Error("Invalid bundle payload.");
  }

  const schemaVersion = typeof record.schemaVersion === "number" ? record.schemaVersion : null;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";

  if (schemaVersion !== 1) {
    throw new Error("Unsupported bundle schema version.");
  }

  if (type === "skill") {
    const content = typeof record.content === "string" ? record.content : "";
    if (!name || !content) {
      throw new Error("Invalid skill bundle payload.");
    }
    return {
      schemaVersion: 1,
      type: "skill",
      name,
      description: typeof record.description === "string" ? record.description : undefined,
      trigger: typeof record.trigger === "string" ? record.trigger : undefined,
      content,
    };
  }

  if (type === "skills-set") {
    const skills = Array.isArray(record.skills)
      ? record.skills.map(readSkillItem).filter((item): item is SkillBundleItem => Boolean(item))
      : [];
    if (!skills.length) {
      throw new Error("Skills set bundle has no importable skills.");
    }
    return {
      schemaVersion: 1,
      type: "skills-set",
      name: name || "Shared skills",
      description: typeof record.description === "string" ? record.description : undefined,
      skills,
    };
  }

  if (type === "workspace-profile") {
    const workspace = readRecord(record.workspace);
    if (!workspace) {
      throw new Error("Workspace profile bundle is missing workspace payload.");
    }
    const files = Array.isArray(workspace.files)
      ? workspace.files.map(readPortableFileItem).filter((item): item is PortableFileItem => Boolean(item))
      : [];
    return {
      schemaVersion: 1,
      type: "workspace-profile",
      name: name || "Shared workspace profile",
      description: typeof record.description === "string" ? record.description : undefined,
      workspace: {
        ...(workspace as OpenworkWorkspaceExport),
        ...(files.length ? { files } : {}),
      },
    };
  }

  throw new Error(`Unsupported bundle type: ${type || "unknown"}`);
}
