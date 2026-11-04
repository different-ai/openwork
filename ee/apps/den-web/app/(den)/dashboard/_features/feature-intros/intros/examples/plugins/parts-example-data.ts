import type { ExampleService } from "../example-parts";
import { LINEAR, NOTION, HUBSPOT } from "./plugins-example-data";

/** Sample data only: no API calls (DESIGN.md I7). */

/** One agent, command or hook as its tab lists it: what it is, and the plugin it came with. */
export type PartsExampleRow = { title: string; detail: string; plugin: string };

export const agentsExampleRows: readonly PartsExampleRow[] = [
  { title: "Deal reviewer", detail: "Checks a deal against the sales playbook before it's sent.", plugin: "Sales playbook" },
  { title: "Changelog writer", detail: "Turns merged work into notes customers can read.", plugin: "Release notes" },
  { title: "Copy editor", detail: "Rewrites drafts in the brand voice.", plugin: "Brand voice" },
];

export const commandsExampleRows: readonly PartsExampleRow[] = [
  { title: "/deal-summary", detail: "Sums up a deal for the weekly review.", plugin: "Sales playbook" },
  { title: "/release-notes", detail: "Drafts the notes for the next release.", plugin: "Release notes" },
  { title: "/brand-check", detail: "Flags words that don't match the brand voice.", plugin: "Brand voice" },
];

/** `detail` is the moment the hook runs. */
export const hooksExampleRows: readonly PartsExampleRow[] = [
  { title: "Load the brand guide", detail: "When a session starts", plugin: "Brand voice" },
  { title: "Check before sending email", detail: "Before a tool is used", plugin: "Sales playbook" },
  { title: "Save a summary", detail: "When a session ends", plugin: "Release notes" },
];

export const mcpsExampleRows: ReadonlyArray<{ service: ExampleService; plugin: string; tools: string }> = [
  { service: HUBSPOT, plugin: "Sales playbook", tools: "32 things" },
  { service: LINEAR, plugin: "Release notes", tools: "24 things" },
  { service: NOTION, plugin: "Brand voice", tools: "15 things" },
];
