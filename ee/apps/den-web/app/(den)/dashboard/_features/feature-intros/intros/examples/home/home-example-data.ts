import type { ExampleProvider } from "../ai-gateway/example-parts";
import { ANTHROPIC, OPENAI } from "../ai-gateway/gateway-example-data";
import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). */

export const homeExample = {
  org: "Acme",
  people: { active: 18, total: 24 },
  models: { providers: [ANTHROPIC, OPENAI] as readonly ExampleProvider[], text: "Claude Sonnet 5, GPT-6 Luna" },
  connectors: { services: [{ name: "Google Workspace" }, { name: "Slack" }, { name: "Linear" }] as readonly ExampleService[], text: "For everyone" },
  plugins: { names: "Release notes, Brand voice", text: "2 plugins" },
} as const;
