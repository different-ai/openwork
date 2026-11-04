import type { ExampleService } from "../example-parts";
import { LINEAR } from "./connectors-example-data";

/** Sample data only: no API calls (DESIGN.md I7). */

export const accessExampleService: ExampleService = LINEAR;

/** As "Who can use it" says it for a connector where each person signs in. */
export const accessExampleSignIn = "Each person signs in with their own Linear account";

export const accessExampleWho: ReadonlyArray<{ initials: string; name: string; detail: string }> = [
  { initials: "EN", name: "Engineering", detail: "Team, 14 people" },
  { initials: "PR", name: "Product", detail: "Team, 6 people" },
  { initials: "SL", name: "Sam Lee", detail: "Support" },
];

/** "What your AI can do" on the connector's page: the first few of its tools. */
export const accessExampleTools: ReadonlyArray<{ title: string; summary: string }> = [
  { title: "Search issues", summary: "Find issues by text, team, status or assignee." },
  { title: "Create issue", summary: "Open a new issue in a team." },
  { title: "Update issue", summary: "Change an issue's status, assignee or priority." },
];

export const accessExampleToolCount = "24 things";
