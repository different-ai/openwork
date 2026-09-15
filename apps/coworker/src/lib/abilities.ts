/** Personal tool selection, not an authorization policy or execution sandbox. */
import { z } from "zod";

const selectionSchema = z.object({
  mode: z.enum(["all", "selected"]),
  ids: z.array(z.string().min(1).max(4096)).max(256).transform((ids) => [...new Set(ids)]),
}).strict();

export const coworkerAbilitiesSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  skills: selectionSchema,
  mcpServers: selectionSchema,
}).strict();

export type CoworkerAbilities = z.infer<typeof coworkerAbilitiesSchema>;
export type AbilitySelection = CoworkerAbilities["skills"];
export type AbilitySkill = {
  id: string;
  name: string;
  description: string;
  source: "local" | "cloud";
  location?: string;
  capability?: string;
};
export type AbilityMcpServer = {
  id: string;
  name: string;
  description: string;
  source: string;
  available: boolean;
  gateway: boolean;
};
export type CoworkerAbilitiesCatalog = {
  skills: AbilitySkill[];
  mcpServers: AbilityMcpServer[];
  /** Partial/unavailable catalogs never replace the saved selection. */
  errors: string[];
};

export function defaultCoworkerAbilities(): CoworkerAbilities {
  return { version: 1, revision: 0, skills: { mode: "all", ids: [] }, mcpServers: { mode: "all", ids: [] } };
}

/** Only an absent legacy field inherits everything. Invalid saved data stays narrow. */
export function readCoworkerAbilities(input: unknown): CoworkerAbilities {
  if (input === undefined) return defaultCoworkerAbilities();
  const parsed = coworkerAbilitiesSchema.safeParse(input);
  return parsed.success ? parsed.data : {
    version: 1, revision: 0, skills: { mode: "selected", ids: [] }, mcpServers: { mode: "selected", ids: [] },
  };
}

export function abilitySelected(selection: AbilitySelection, id: string): boolean {
  return selection.mode === "all" || selection.ids.includes(id);
}

export function localSkillAbilityId(location: string): string {
  return `local:${location}`;
}

export function cloudSkillAbilityId(capability: string): string {
  return `cloud:${capability}`;
}

export function mcpAbilityId(name: string): string {
  return `mcp:${name}`;
}

/** Match the native namespace, longest first so "notes" cannot own "notes_team". */
export function mcpServerForTool(tool: string, serverNames: string[]): string | undefined {
  return [...serverNames].sort((a, b) => b.length - a.length).find((name) =>
    tool.startsWith(`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`));
}

export function abilitiesSummary(input: CoworkerAbilities | undefined): string {
  const value = readCoworkerAbilities(input);
  const skills = value.skills.mode === "all" ? "All skills" : `${value.skills.ids.length} selected skill${value.skills.ids.length === 1 ? "" : "s"}`;
  const servers = value.mcpServers.mode === "all" ? "all MCP servers" : `${value.mcpServers.ids.length} selected MCP server${value.mcpServers.ids.length === 1 ? "" : "s"}`;
  return `${skills} · ${servers}`;
}
