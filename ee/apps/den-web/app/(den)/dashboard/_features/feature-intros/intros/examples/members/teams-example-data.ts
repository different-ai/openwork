import type { ExampleProvider } from "../ai-gateway/example-parts";
import { ANTHROPIC, OPENAI, OPENWORK_MODELS } from "../ai-gateway/gateway-example-data";
import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */

export const GITHUB: ExampleService = { name: "GitHub" };
export const LINEAR: ExampleService = { name: "Linear" };
export const HUBSPOT: ExampleService = { name: "HubSpot" };
export const NOTION: ExampleService = { name: "Notion" };

export type TeamsExampleRow = {
  initials: string;
  name: string;
  people: string;
  /** Role, as in the Teams list. */
  role: string;
  /** What the team is given: AI providers, then connectors. */
  providers: readonly ExampleProvider[];
  services: readonly ExampleService[];
  plugins: string;
};

export const teamsExampleRows: readonly TeamsExampleRow[] = [
  { initials: "EN", name: "Engineering", people: "12 members", role: "Member", providers: [ANTHROPIC, OPENAI], services: [GITHUB], plugins: "Release notes" },
  { initials: "SA", name: "Sales", people: "8 members", role: "Member", providers: [OPENWORK_MODELS], services: [HUBSPOT], plugins: "Sales playbook" },
  { initials: "OP", name: "Operations", people: "3 members", role: "Admin", providers: [ANTHROPIC], services: [NOTION], plugins: "Brand voice" },
];

export const teamsExampleEveryone = { name: "Everyone", people: "35 members", detail: "Every member starts here" };
