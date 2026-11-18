import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */

export const GITHUB: ExampleService = { name: "GitHub" };
export const HUBSPOT: ExampleService = { name: "HubSpot" };
export const LINEAR: ExampleService = { name: "Linear" };
export const NOTION: ExampleService = { name: "Notion" };

export type PluginsExampleRow = {
  name: string;
  /** What's inside, as the plugin rows count it. */
  inside: string;
  /** Who can use it, as "Who can use it" says it. */
  audience: string;
  /** A GitHub repository, or made in OpenWork. */
  source: { kind: "github"; repo: string } | { kind: "here" };
};

export const pluginsExampleRows: readonly PluginsExampleRow[] = [
  { name: "Sales playbook", inside: "4 skills, 2 commands", audience: "Sales", source: { kind: "github", repo: "acme/sales-plugins" } },
  { name: "Release notes", inside: "2 skills, 1 command", audience: "Everyone", source: { kind: "here" } },
  { name: "Brand voice", inside: "3 skills, 1 connector", audience: "Marketing", source: { kind: "here" } },
];

/** One person using a shared plugin, as steps read in chat (C4): sentence first, result on the right. */
export const pluginsExampleChat = {
  initials: "SL",
  prompt: "Draft the release notes for 4.2",
  steps: [
    { sentence: "Used the Release notes skill", result: null },
    { sentence: "Read 18 merged pull requests", result: null },
    { sentence: "Wrote the draft", result: "1 document" },
  ],
} as const;
