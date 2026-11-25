export const SKILL_STEPS_PREVIEW_LINES = 8;

export function skillTitle(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function previewSkillSteps(body: string, lines = SKILL_STEPS_PREVIEW_LINES): { text: string; truncated: boolean } {
  const all = body.split("\n");
  if (all.length <= lines) return { text: body, truncated: false };
  return { text: all.slice(0, lines).join("\n").trimEnd(), truncated: true };
}

export function librarySkillsLabel(single: boolean, count: number | null): string {
  if (single) return "Steps";
  if (count === null) return "Skills";
  return count === 1 ? "1 skill" : `${count} skills`;
}
