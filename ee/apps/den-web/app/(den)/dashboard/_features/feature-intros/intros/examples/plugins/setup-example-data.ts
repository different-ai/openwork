import type { ExampleService } from "../example-parts";
import { HUBSPOT } from "./plugins-example-data";

/** Sample data only: no API calls (DESIGN.md I7). */

/** "Create a plugin": its name, then What's inside, as the form fills it in. */
export const createExamplePlugin = { name: "Sales playbook", description: "How we prepare, run and follow up on sales calls" };

export const createExampleInside: ReadonlyArray<
  { kind: "Skill" | "Command"; title: string; detail: string } | { kind: "Connector"; service: ExampleService; detail: string }
> = [
  { kind: "Skill", title: "Prep a sales call", detail: "When someone has a call with a customer coming up" },
  { kind: "Command", title: "/follow-up", detail: "Writes the follow-up email after a call" },
  { kind: "Connector", service: HUBSPOT, detail: "Reads the account and its open deals" },
];

export const createExampleFootnote = "Nobody else gets it until you choose who can use it.";

/** "Import from GitHub": a public plugin's link, then what the preview found in it. */
export const importExampleUrl = "github.com/anthropics/knowledge-work-plugins/tree/main/sales";

export const importExampleItems: ReadonlyArray<{ kind: "Skill" | "MCP server"; name: string; status: string; supported: boolean }> = [
  { kind: "Skill", name: "call-prep", status: "Ready", supported: true },
  { kind: "Skill", name: "account-research", status: "Ready", supported: true },
  { kind: "MCP server", name: "HubSpot", status: "Ready", supported: true },
  { kind: "MCP server", name: "local-crm", status: "Desktop-only servers cannot be imported", supported: false },
];

/** A skill as its editor saves it: name, when to use it, and the steps. */
export const skillExample = {
  name: "prep-a-sales-call",
  description: "Use when someone has a customer call coming up.",
  steps: [
    "Look up the account and its open deals.",
    "List what changed since the last call.",
    "Suggest three questions to ask.",
  ],
};
