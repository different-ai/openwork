import type { ExampleProvider } from "../ai-gateway/example-parts";
import { ANTHROPIC, OPENAI } from "../ai-gateway/gateway-example-data";

/** Sample data only: no API calls (DESIGN.md I7). Laid out like a team's Models tab. */

export const teamModelsExampleTeam = "Engineering";

export const teamModelsExampleDefault = { provider: ANTHROPIC, model: "claude-sonnet-4-5" };

export const teamModelsExampleProviders: ReadonlyArray<{ provider: ExampleProvider; models: string; source: string }> = [
  { provider: ANTHROPIC, models: "claude-sonnet-4-5, claude-haiku-4-5", source: "Everyone" },
  { provider: OPENAI, models: "gpt-5, gpt-5-mini", source: "This team" },
];

export const teamModelsExampleLimit = { amount: "$200 a month", used: "$64", percent: 32 };
