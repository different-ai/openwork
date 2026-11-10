/** The sidebar's groups on a team's page and Everyone's page, in the order they are shown. */
const TEAM_SECTION_GROUPS = [
  { label: "People", sections: ["role", "overview"] },
  { label: "Permissions", sections: ["access", "agents", "browser"] },
  { label: "AI", sections: ["models", "workbot", "prompts"] },
  { label: "Apps", sections: ["desktop"] },
] as const;

export type TeamSectionGroup<Item> = { label: string; items: Item[] };

/**
 * Puts the page's sections under their sidebar groups, keeping each group's own order.
 * A group with nothing to show is left out; a section no group names goes last, under "More".
 */
export function groupTeamSections<Item extends { value: string }>(items: readonly Item[]): TeamSectionGroup<Item>[] {
  const grouped = new Set<string>();
  const groups: TeamSectionGroup<Item>[] = TEAM_SECTION_GROUPS.map((group) => ({
    label: group.label,
    items: group.sections.flatMap((section) => {
      const item = items.find((entry) => entry.value === section);
      if (!item) return [];
      grouped.add(section);
      return [item];
    }),
  }));
  const rest = items.filter((item) => !grouped.has(item.value));
  if (rest.length > 0) groups.push({ label: "More", items: rest });
  return groups.filter((group) => group.items.length > 0);
}
