/**
 * Creator Mode presets: a saved runtime composition for a workspace — skill
 * contents, plugin specs, MCP server configs and commands — stored locally and
 * portable via export/import. Applying a preset replays those writes against a
 * workspace through the normal openwork-server surfaces, the same way the
 * Personalización page writes each piece one by one.
 *
 * Note: MCP configs may contain credentials. Presets live in this browser's
 * localStorage and export as plain JSON — review them before sharing.
 */

export type CreatorPreset = {
  id: string;
  name: string;
  createdAt: number;
  workspaceId: string;
  skills: Array<{ name: string; content: string; description?: string }>;
  plugins: Array<{ spec: string }>;
  mcp: Array<{ name: string; config: Record<string, unknown> }>;
  commands: Array<{ name: string; template: string; description?: string; agent?: string; model?: string | null; subtask?: boolean }>;
};

const STORAGE_KEY = "openwork.creatorPresets.v1";

function readAll(): CreatorPreset[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CreatorPreset =>
      Boolean(item) && typeof item === "object"
      && typeof (item as CreatorPreset).id === "string"
      && typeof (item as CreatorPreset).name === "string"
      && Array.isArray((item as CreatorPreset).skills));
  } catch {
    return [];
  }
}

function writeAll(presets: CreatorPreset[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Storage unavailable: presets stay in memory for this session only.
  }
}

export function listPresets(): CreatorPreset[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export function savePreset(preset: CreatorPreset): CreatorPreset[] {
  const next = [preset, ...readAll().filter((item) => item.id !== preset.id)];
  writeAll(next);
  return next;
}

export function deletePreset(id: string): CreatorPreset[] {
  const next = readAll().filter((item) => item.id !== id);
  writeAll(next);
  return next;
}

/** Summaries for the apply-confirm dialog: what a preset would write. */
export function describePreset(preset: CreatorPreset): string {
  const parts = [
    `${preset.skills.length} skill${preset.skills.length === 1 ? "" : "s"}`,
    `${preset.plugins.length} plugin${preset.plugins.length === 1 ? "" : "s"}`,
    `${preset.mcp.length} MCP`,
    `${preset.commands.length} comando${preset.commands.length === 1 ? "" : "s"}`,
  ];
  return parts.join(", ");
}
