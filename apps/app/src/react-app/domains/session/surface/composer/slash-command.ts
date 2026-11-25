import fuzzysort from "fuzzysort";
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

export type SlashTrigger = { query: string; offset: number };

export function slashTriggerAtCaret(text: string, caret: number) {
  const before = text.slice(0, caret);
  const offset = before.lastIndexOf("/");
  if (offset < 0 || (offset > 0 && !/\s/.test(text[offset - 1]))) return null;
  const query = before.slice(offset + 1);
  if (/^\s/.test(query) || /[\r\n]/.test(query)) return null;

  const restOfWord = text.slice(caret).match(/^\S*/)?.[0] ?? "";
  if (restOfWord.includes("/")) return null;
  return { query, offset, end: caret + restOfWord.length };
}

function normalizeSlashSearch(value: string) {
  return value.replace(/[-_\s]+/g, " ").trim();
}

export function filterSlashCommands(items: ComposerSlashCommandOption[], trigger: SlashTrigger, limit = 8) {
  const eligible = trigger.offset === 0 ? items : items.filter((item) => item.source === "skill");
  const query = normalizeSlashSearch(trigger.query);
  if (!query) return eligible.slice(0, limit);
  const keys = [
    (item: ComposerSlashCommandOption) => normalizeSlashSearch(item.name),
    (item: ComposerSlashCommandOption) => item.skill ? normalizeSlashSearch(item.skill.name) : "",
  ];
  if (!/\s/.test(trigger.query)) keys.push((item) => item.description ?? "");
  return fuzzysort.go(query, eligible, { keys, limit }).map((entry) => entry.obj);
}

export function parseSlashCommandInvocation(value: string) {
  const match = value.trim().match(SLASH_COMMAND_INVOCATION_RE);
  if (!match) return null;
  const name = match[1];
  if (!name) return null;
  return { name, arguments: match[2] ?? "" };
}
