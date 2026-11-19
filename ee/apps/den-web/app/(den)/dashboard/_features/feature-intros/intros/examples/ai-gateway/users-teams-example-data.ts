import type { ExampleProvider } from "./example-parts";
import { ANTHROPIC, GOOGLE, OPENAI, OPENWORK_MODELS } from "./gateway-example-data";

/** Sample data only: no API calls (DESIGN.md I7). */

export const usersTeamsExampleRows: ReadonlyArray<{
  name: string;
  initials: string;
  detail: string;
  limit: string;
  providers: readonly ExampleProvider[];
  spend: string;
}> = [
  { name: "Everyone in Acme", initials: "AC", detail: "35 people", limit: "$50 a month", providers: [ANTHROPIC, OPENWORK_MODELS], spend: "$546" },
  { name: "Engineering", initials: "EN", detail: "12 people", limit: "$200 a month", providers: [ANTHROPIC, OPENAI, OPENWORK_MODELS], spend: "$412" },
  { name: "Maya Chen", initials: "MC", detail: "Design", limit: "$100 a month", providers: [ANTHROPIC, GOOGLE], spend: "$64" },
  { name: "Leo Park", initials: "LP", detail: "Sales", limit: "No limit", providers: [OPENWORK_MODELS], spend: "$0" },
];
