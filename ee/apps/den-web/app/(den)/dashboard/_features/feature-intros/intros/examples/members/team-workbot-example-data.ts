import type { ExampleProvider } from "../ai-gateway/example-parts";
import { ANTHROPIC, OPENAI } from "../ai-gateway/gateway-example-data";

/**
 * Sample data only: no API calls (DESIGN.md I7). One row per team: whether it has Workbot, what it calls it and the
 * model it starts on, and whether that is Everyone's or the team's own.
 */

export const teamWorkbotExampleRows: ReadonlyArray<{ team: string; enabled: boolean; name: string; provider: ExampleProvider; model: string; source: string }> = [
  { team: "Support", enabled: true, name: "Helpdesk", provider: ANTHROPIC, model: "Claude Sonnet 4.5", source: "Changed for Support" },
  { team: "Sales", enabled: true, name: "Workbot", provider: OPENAI, model: "GPT-6 Luna", source: "From Everyone" },
  { team: "Engineering", enabled: false, name: "Workbot", provider: OPENAI, model: "GPT-6 Luna", source: "Changed for Engineering" },
];
