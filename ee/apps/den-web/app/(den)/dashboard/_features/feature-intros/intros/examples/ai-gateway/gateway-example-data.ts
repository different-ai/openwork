import type { ExampleProvider } from "./example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */

export const OPENWORK_MODELS: ExampleProvider = { providerId: "openwork", name: "OpenWork Models" };
export const ANTHROPIC: ExampleProvider = { providerId: "anthropic", name: "Anthropic" };
export const OPENAI: ExampleProvider = { providerId: "openai", name: "OpenAI" };
export const GOOGLE: ExampleProvider = { providerId: "google", name: "Google" };

export const gatewayExampleProviders: ReadonlyArray<{ provider: ExampleProvider; detail: string }> = [
  { provider: ANTHROPIC, detail: "Shared key, 6 models" },
  { provider: OPENAI, detail: "Shared key, 4 models" },
  { provider: OPENWORK_MODELS, detail: "No keys, 9 models" },
];

export const gatewayExampleAudiences: ReadonlyArray<{
  name: string;
  initials: string;
  people: string;
  providers: readonly ExampleProvider[];
  spend: string;
  spendShare: number;
}> = [
  { name: "Engineering", initials: "EN", people: "12 people", providers: [ANTHROPIC, OPENAI, OPENWORK_MODELS], spend: "$412", spendShare: 412 },
  { name: "Design", initials: "DE", people: "5 people", providers: [ANTHROPIC, OPENWORK_MODELS], spend: "$96", spendShare: 96 },
  { name: "Everyone else", initials: "EV", people: "18 people", providers: [ANTHROPIC, OPENWORK_MODELS], spend: "$38", spendShare: 38 },
];

export const gatewayExampleTotal = "$546";
