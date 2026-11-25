import type { ExampleProvider } from "../ai-gateway/example-parts";
import { ANTHROPIC, GOOGLE, OPENAI } from "../ai-gateway/gateway-example-data";
import type { ExampleService } from "../example-parts";

export type LibraryExampleKind = "connector" | "skill" | "plugin" | "model";

export type LibraryExampleRow = {
  name: string;
  kind: LibraryExampleKind;
  service?: ExampleService;
  provider?: ExampleProvider;
  detail: string;
  source: string;
  signIn?: boolean;
};

const GOOGLE_WORKSPACE: ExampleService = { name: "Google Workspace" };
const SLACK: ExampleService = { name: "Slack" };
const LINEAR: ExampleService = { name: "Linear" };
const NOTION: ExampleService = { name: "Notion" };

export const libraryExampleGroups: ReadonlyArray<{ title: string; rows: readonly LibraryExampleRow[] }> = [
  {
    title: "Needs your sign-in",
    rows: [{ name: "Linear", kind: "connector", service: LINEAR, detail: "Issues and projects", source: "Product", signIn: true }],
  },
  {
    title: "Shared with you",
    rows: [
      { name: "Google Workspace", kind: "connector", service: GOOGLE_WORKSPACE, detail: "Gmail, Calendar and Drive", source: "Everyone" },
      { name: "Slack", kind: "connector", service: SLACK, detail: "Channels and messages", source: "Everyone" },
      { name: "Release notes", kind: "skill", detail: "Skill", source: "Everyone" },
      { name: "Sales playbook", kind: "plugin", detail: "3 skills and HubSpot", source: "Sales" },
      { name: "Claude Sonnet 5", kind: "model", provider: ANTHROPIC, detail: "Model", source: "Everyone" },
    ],
  },
  {
    title: "Yours",
    rows: [{ name: "Weekly report", kind: "skill", detail: "Skill", source: "You" }],
  },
];

export const libraryConnectorRows: readonly LibraryExampleRow[] = [
  { name: "Google Workspace", kind: "connector", service: GOOGLE_WORKSPACE, detail: "Signed in", source: "Everyone" },
  { name: "Slack", kind: "connector", service: SLACK, detail: "Signed in", source: "Everyone" },
  { name: "Linear", kind: "connector", service: LINEAR, detail: "Issues and projects", source: "Product", signIn: true },
  { name: "Notion", kind: "connector", service: NOTION, detail: "Signed in", source: "You" },
];

export const librarySkillRows: readonly LibraryExampleRow[] = [
  { name: "Release notes", kind: "skill", detail: "Writes release notes from merged changes", source: "Everyone" },
  { name: "Brand voice", kind: "skill", detail: "Checks copy against the brand guide", source: "Marketing" },
  { name: "Weekly report", kind: "skill", detail: "Sums up your week from Linear and Slack", source: "You" },
];

export const libraryPluginRows: readonly LibraryExampleRow[] = [
  { name: "Sales playbook", kind: "plugin", detail: "3 skills, /follow-up and HubSpot", source: "Sales" },
  { name: "Customer research", kind: "plugin", detail: "2 skills and Notion", source: "Everyone" },
];

export const libraryModelRows: readonly LibraryExampleRow[] = [
  { name: "Claude Sonnet 5", kind: "model", provider: ANTHROPIC, detail: "Anthropic", source: "Everyone" },
  { name: "GPT-6 Luna", kind: "model", provider: OPENAI, detail: "OpenAI", source: "Everyone" },
  { name: "Gemini 3 Pro", kind: "model", provider: GOOGLE, detail: "Google", source: "Engineering", signIn: true },
  { name: "Anthropic", kind: "model", provider: ANTHROPIC, detail: "Your key", source: "You" },
];

export const libraryModelKey = {
  provider: ANTHROPIC,
  name: "Anthropic",
  access: "Only you",
  models: ["Claude Sonnet 5", "Claude Haiku 5"],
} as const;

export const libraryShareExample = {
  item: "Weekly report",
  kind: "Skill",
  people: [
    { initials: "PR", name: "Product", detail: "Team, 6 people" },
    { initials: "SL", name: "Sam Lee", detail: "sam@acme.com" },
  ],
} as const;
