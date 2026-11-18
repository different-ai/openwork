import type { ExampleProvider } from "../ai-gateway/example-parts";

/** Sample data only: no API calls (DESIGN.md I7). Numbers follow the real Usage & adoption cards ("Active this week", "Sessions this week", "Tasks this week"). */

export const analyticsExampleStats: ReadonlyArray<{ title: string; value: string; sub: string }> = [
  { title: "Active people", value: "18", sub: "of 24 people" },
  { title: "Sessions", value: "412", sub: "by 18 people" },
  { title: "Tasks", value: "1,280", sub: "96% success" },
];

/** Daily active people for the last 14 days, oldest first; weekends dip. */
export const analyticsExampleDaily: readonly number[] = [9, 11, 12, 10, 4, 3, 12, 14, 15, 13, 16, 5, 4, 18];

export const analyticsExampleModels: ReadonlyArray<{ label: string; provider: ExampleProvider; sessions: number }> = [
  { label: "Claude Sonnet 5", provider: { providerId: "anthropic", name: "Anthropic" }, sessions: 214 },
  { label: "GPT-6 Luna", provider: { providerId: "openai", name: "OpenAI" }, sessions: 131 },
  { label: "Gemini 3 Pro", provider: { providerId: "google", name: "Google" }, sessions: 67 },
];
