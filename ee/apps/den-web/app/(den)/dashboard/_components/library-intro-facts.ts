import type { LibraryFacts } from "../_features/feature-intros/intros/library";
import type { LibraryItem } from "./library-data";
import { libraryFilterOf } from "./library-view";

/**
 * My Library facts (DESIGN.md I2) from what the page already loads: the
 * Library items, the organization's models for the viewer and the viewer's
 * own model keys. Null until all three are known, so the page never gives way
 * to an intro while something is still loading.
 */
export function libraryIntroFacts(input: {
  items: readonly LibraryItem[] | undefined;
  models: number | undefined;
  personalModels: number | undefined;
}): LibraryFacts | null {
  if (!input.items || input.models === undefined || input.personalModels === undefined) return null;
  const seen = new Set<string>();
  const counts = { connectors: 0, skills: 0, plugins: 0, workflows: 0 };
  for (const item of input.items) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = libraryFilterOf(item);
    if (kind === "connectors" || kind === "skills" || kind === "plugins") counts[kind] += 1;
    else counts.workflows += 1;
  }
  const models = input.models + input.personalModels;
  return {
    items: counts.connectors + counts.skills + counts.plugins + counts.workflows + models,
    connectors: counts.connectors,
    skills: counts.skills,
    plugins: counts.plugins,
    models,
  };
}
