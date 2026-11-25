import type { ExampleService } from "../example-parts";

export const GITHUB: ExampleService = { name: "GitHub" };
export const HUBSPOT: ExampleService = { name: "HubSpot" };
export const LINEAR: ExampleService = { name: "Linear" };
export const NOTION: ExampleService = { name: "Notion" };

export type PluginsExampleRow = {
  name: string;
  inside: string;
  audience: string;
  source: { kind: "github"; repo: string } | { kind: "here" };
};

export const pluginsExampleRows: readonly PluginsExampleRow[] = [
  { name: "Sales playbook", inside: "4 skills, 2 commands", audience: "Sales", source: { kind: "github", repo: "acme/sales-plugins" } },
  { name: "Release notes", inside: "2 skills, 1 command", audience: "Everyone", source: { kind: "here" } },
  { name: "Brand voice", inside: "3 skills, 1 connector", audience: "Marketing", source: { kind: "here" } },
];

export const pluginsExampleChat = {
  initials: "SL",
  prompt: "Draft the release notes for 4.2",
  steps: [
    { sentence: "Used the Release notes skill", result: null },
    { sentence: "Read 18 merged pull requests", result: null },
    { sentence: "Wrote the draft", result: "1 document" },
  ],
} as const;
