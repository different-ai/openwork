// Deliberately separated colors for the first categories, before adding shades.
// Assign slots across the chart, rather than hashing each ID independently:
// unrelated IDs can otherwise produce almost indistinguishable colors.
const palette = [
  "#2563eb", "#ea580c", "#16a34a", "#9333ea", "#dc2626", "#0891b2",
  "#ca8a04", "#db2777", "#0d9488", "#64748b", "#4f46e5", "#65a30d",
  "#c2410c", "#a21caf", "#0284c7", "#be123c", "#15803d", "#7c3aed",
  "#a16207", "#475569", "#0e7490", "#c026d3", "#059669", "#92400e",
];

export function assignSeriesColors(ids: string[], previous: ReadonlyMap<string, string> = new Map()): ReadonlyMap<string, string> {
  const missing = [...new Set(ids)].filter((id) => !previous.has(id)).sort();
  if (!missing.length) return previous;
  const colors = new Map(previous);
  for (const id of missing) {
    const index = colors.size;
    const extra = index - palette.length;
    colors.set(id, palette[index] ?? `hsl(${((extra * 137.508 + 17) % 360).toFixed(2)} 65% ${40 + (extra % 3) * 8}%)`);
  }
  return colors;
}
