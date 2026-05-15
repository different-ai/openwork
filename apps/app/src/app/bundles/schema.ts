import type {
  BundleImportSummary,
  BundleV1,
  SkillBundleItem,
} from "./types";

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

  throw new Error(`Unsupported bundle type: ${(bundle as { type?: string }).type || "unknown"}`);
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
      ? record.skills.flatMap((item) => {
          const skill = readSkillItem(item);
          return skill ? [skill] : [];
        })
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

  throw new Error(`Unsupported bundle type: ${type || "unknown"}`);
}
