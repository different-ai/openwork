import type { SkillCard, SlashCommandOption } from "@/app/types";

const SLASH_COMMAND_QUERY_RE = /^\/([A-Za-z0-9_-]*)$/;
const SLASH_COMMAND_INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/;

export type ComposerSlashCommandOption = SlashCommandOption & {
  skill?: SkillCard;
};

export function skillSlashCommandName(skill: Pick<SkillCard, "name" | "trigger">) {
  const trigger = skill.trigger?.trim();
  if (trigger && /^[A-Za-z0-9_-]+$/.test(trigger)) return trigger;
  const slug = skill.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

export function skillMenuSlashCommandName(skill: Pick<SkillCard, "name" | "trigger" | "origin">) {
  return skill.origin === "openwork-connect" ? skillSlashCommandName(skill) : skill.name;
}

export function connectSkillSlashCommandOptions(skills: SkillCard[]): ComposerSlashCommandOption[] {
  return skills.flatMap((skill) => {
    if (skill.origin !== "openwork-connect" || !skill.connectCapabilityName) return [];
    return [{
      id: `connect-skill:${skill.connectCapabilityName}`,
      name: skillSlashCommandName(skill),
      description: [
        skill.description,
        [skill.marketplaceName, skill.pluginName].filter(Boolean).join(" · "),
      ].filter(Boolean).join(" — "),
      source: "skill",
      skill,
    }];
  });
}

export function getSlashCommandQuery(value: string) {
  const match = value.match(SLASH_COMMAND_QUERY_RE);
  return match ? match[1] : null;
}

export function parseSlashCommandInvocation(value: string) {
  const match = value.trim().match(SLASH_COMMAND_INVOCATION_RE);
  if (!match) return null;
  const name = match[1];
  if (!name) return null;
  return { name, arguments: match[2] ?? "" };
}
