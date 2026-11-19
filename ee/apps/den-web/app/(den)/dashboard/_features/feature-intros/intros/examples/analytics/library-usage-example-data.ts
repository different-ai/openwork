/** Sample data only: no API calls (DESIGN.md I7). Columns follow the real Plugins & connectors table (skill, its plugin, uses, last used). */

export const libraryUsageExampleRows: ReadonlyArray<{ name: string; plugin: string; uses: number; lastUsed: string }> = [
  { name: "Release notes", plugin: "Release notes", uses: 214, lastUsed: "2 hours ago" },
  { name: "Brand voice", plugin: "Marketing kit", uses: 96, lastUsed: "Yesterday" },
  { name: "Deal summary", plugin: "Sales playbook", uses: 41, lastUsed: "3 days ago" },
  { name: "Weekly report", plugin: "Ops toolkit", uses: 0, lastUsed: "Not used" },
];
