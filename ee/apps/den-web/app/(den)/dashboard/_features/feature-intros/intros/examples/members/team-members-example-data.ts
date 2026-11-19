import type { ExampleProvider } from "../ai-gateway/example-parts";
import { ANTHROPIC, OPENAI } from "../ai-gateway/gateway-example-data";
import type { ExampleService } from "../example-parts";
import { GITHUB, LINEAR } from "./teams-example-data";

/** Sample data only: no API calls (DESIGN.md I7). */

export const teamMembersExampleTeam = "Engineering";

export const teamMembersExampleRows: ReadonlyArray<{ initials: string; name: string; detail: string }> = [
  { initials: "GH", name: "Grace Hopper", detail: "Admin" },
  { initials: "LT", name: "Linus Torvalds", detail: "Member, also in Operations" },
  { initials: "MC", name: "Maya Chen", detail: "Member" },
];

/** What everyone in the team gets from it. */
export const teamMembersExampleGets: { providers: readonly ExampleProvider[]; services: readonly ExampleService[]; plugins: string } = {
  providers: [ANTHROPIC, OPENAI],
  services: [GITHUB, LINEAR],
  plugins: "Release notes, Code review",
};
