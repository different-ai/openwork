import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). A chat in OpenWork Web, steps read as in chat (C4). */

const SLACK: ExampleService = { name: "Slack" };
const GOOGLE_WORKSPACE: ExampleService = { name: "Google Workspace" };

export const webExampleChat = {
  address: "OpenWork Web",
  initials: "SL",
  prompt: "Sum up this week in #launch for Friday's update",
  steps: [
    { service: SLACK, sentence: "Read #launch", result: "42 messages" },
    { service: GOOGLE_WORKSPACE, sentence: "Found the launch plan in Drive", result: "1 file" },
    { service: null, sentence: "Drafted the update", result: "" },
  ] as ReadonlyArray<{ service: ExampleService | null; sentence: string; result: string }>,
} as const;
