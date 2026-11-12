import type { ExampleProvider } from "./example-parts";
import { ANTHROPIC, GOOGLE, OPENAI } from "./gateway-example-data";

/** Sample data only: no API calls (DESIGN.md I7). */

export const providersExampleRows: ReadonlyArray<{
  provider: ExampleProvider;
  models: string;
  audience: string;
  status: "Ready" | "Add a key";
}> = [
  { provider: ANTHROPIC, models: "All models", audience: "Everyone", status: "Ready" },
  { provider: OPENAI, models: "4 models", audience: "Engineering", status: "Ready" },
  { provider: GOOGLE, models: "All models", audience: "Design, Research", status: "Add a key" },
];
