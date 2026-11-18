import type { ExampleProvider } from "./example-parts";
import { ANTHROPIC, GOOGLE } from "./gateway-example-data";

/** Sample data only: no API calls (DESIGN.md I7). */

export const smartRouterExampleName = "Smart: Engineering";

export type SmartRouterExampleModel = { id: string; name: string; provider: ExampleProvider; tasks: readonly string[] };

export const smartRouterExampleModels: readonly SmartRouterExampleModel[] = [
  { id: "opus", name: "Claude Opus", provider: ANTHROPIC, tasks: ["Debugging", "Architecture"] },
  { id: "haiku", name: "Claude Haiku", provider: ANTHROPIC, tasks: ["Quick questions", "Short emails"] },
  { id: "gemini", name: "Gemini Pro", provider: GOOGLE, tasks: ["Long documents"] },
];

export const smartRouterExamplePrompts: ReadonlyArray<{ prompt: string; modelId: string; thinking: string }> = [
  { prompt: "Why does this test fail on CI?", modelId: "opus", thinking: "High" },
  { prompt: "Reply to Sam: Thursday works", modelId: "haiku", thinking: "Low" },
  { prompt: "Summarize this 40-page contract", modelId: "gemini", thinking: "Medium" },
];
