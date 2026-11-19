import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */
export const collectionsExampleRows: ReadonlyArray<{ name: string; builtIn?: boolean; initials: string; plugins: string; audience: string }> = [
  { name: "OpenWork Marketplace", builtIn: true, initials: "OW", plugins: "3 plugins", audience: "Everyone" },
  { name: "Sales enablement", initials: "SE", plugins: "4 plugins", audience: "Sales" },
  { name: "Engineering tools", initials: "ET", plugins: "6 plugins", audience: "Engineering, Platform" },
];

/** One collection's plugins, for the box on a collection with none yet. */
export const collectionPluginsExampleAudience = "Sales gets all three";
export const collectionPluginsExampleRows: ReadonlyArray<{ name: string; contents: string; services: readonly ExampleService[] }> = [
  { name: "Account research", contents: "2 skills, 1 connector", services: [{ name: "Google Workspace" }] },
  { name: "Proposal writer", contents: "1 skill, 1 command", services: [] },
  { name: "Deal updates", contents: "1 skill, 1 connector", services: [{ name: "Slack" }] },
];
