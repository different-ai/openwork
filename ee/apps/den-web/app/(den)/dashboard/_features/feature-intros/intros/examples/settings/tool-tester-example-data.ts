import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */
export const toolTesterExample: {
  service: ExampleService;
  connection: string;
  signedIn: string;
  tool: string;
  args: string;
  result: string;
} = {
  service: { name: "Linear" },
  connection: "Linear",
  signedIn: "Connected as you",
  tool: "list_issues",
  args: '{ "team": "Product", "state": "In progress" }',
  result: "12 issues · 318 ms",
};

export const toolTesterExampleTools: ReadonlyArray<{ name: string; on: boolean }> = [
  { name: "list_issues", on: true },
  { name: "create_issue", on: true },
  { name: "delete_issue", on: false },
];
