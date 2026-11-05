import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */

export const GOOGLE_WORKSPACE: ExampleService = { name: "Google Workspace" };
export const SLACK: ExampleService = { name: "Slack" };
export const LINEAR: ExampleService = { name: "Linear" };
export const GITHUB: ExampleService = { name: "GitHub" };

/** Rows as on Connectors: how people sign in, and who has it (right, like the list's source). */
export const connectorsExampleRows: ReadonlyArray<{
  service: ExampleService;
  signIn: string;
  audience: string;
}> = [
  { service: GOOGLE_WORKSPACE, signIn: "Each person signs in", audience: "Everyone" },
  { service: SLACK, signIn: "Each person signs in", audience: "Everyone" },
  { service: LINEAR, signIn: "Each person signs in", audience: "Product" },
  { service: GITHUB, signIn: "One account for everyone", audience: "Engineering" },
];

/** What people's AI did with them, as steps read in chat (C4): sentence first, result on the right. */
export const connectorsExampleActivity: ReadonlyArray<{
  service: ExampleService;
  sentence: string;
  result: string;
}> = [
  { service: GOOGLE_WORKSPACE, sentence: "Found the Q3 plan in Drive", result: "1 file" },
  { service: SLACK, sentence: "Read #launch", result: "24 messages" },
  { service: LINEAR, sentence: "Searched Linear for open issues", result: "8 issues" },
  { service: GITHUB, sentence: "Opened a pull request", result: "web-app" },
];
