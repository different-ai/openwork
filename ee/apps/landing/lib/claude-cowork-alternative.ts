import type { CompareCard, CompareColumn, CompareRow, CompareSource } from "./compare";
import { compareMarkdownTable, sourcesMarkdown } from "./compare";
import type { FaqEntry } from "./faq";

export const CLAUDE_COWORK_ALTERNATIVE_PATH = "/alternatives/claude-cowork";
export const CLAUDE_COWORK_ALTERNATIVE_URL = `https://openworklabs.com${CLAUDE_COWORK_ALTERNATIVE_PATH}`;
export const MIGRATION_GUIDE_PATH = "/docs/start-here/migrate-from-claude-cowork";

export const claudeCoworkAlternativeHeading = "The free, open-source alternative to Claude Cowork";

/** Hero sub-line. Keep it under 20 words. */
export const claudeCoworkAlternativeAnswer =
  "Any model, your own keys, files that stay on your machine. Free for macOS, Windows, and Linux.";

export type CoworkColumnKey = "openwork" | "cowork";

export const comparisonColumns: CompareColumn<CoworkColumnKey>[] = [
  { key: "openwork", label: "OpenWork" },
  { key: "cowork", label: "Claude Cowork" }
];

// Keep the Claude Cowork column factual and neutral: describe what Anthropic
// offers, never claim a limitation we cannot verify.
export const comparisonRows: CompareRow<CoworkColumnKey>[] = [
  { label: "Free and open source", openwork: true, cowork: false },
  { label: "Linux", openwork: true, cowork: false },
  { label: "Any model, 50+ providers", openwork: true, cowork: "Claude only" },
  { label: "Local models", openwork: true, cowork: false },
  { label: "Your own API keys", openwork: true, cowork: "On 3P" },
  { label: "Skills, plugins, MCP", openwork: true, cowork: true },
  { label: "Share skills with your team", openwork: true, cowork: "Team plans" },
  { label: "Self-host", openwork: true, cowork: false }
];

export const comparisonSources: CompareSource[] = [
  { label: "Claude Team plan", href: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan" },
  { label: "Claude Enterprise pricing", href: "https://claude.com/pricing/enterprise" },
  { label: "Claude Desktop on 3P", href: "https://claude.com/docs/third-party/claude-desktop/overview" }
];

export const alternativeCards: CompareCard[] = [
  {
    icon: "cpu",
    title: "Run local models with Ollama or LM Studio",
    link: { label: "Add a local model", href: "/docs/start-here/connect-your-stack/add-a-custom-llm" }
  },
  {
    icon: "key",
    title: "Bring your own key or AI gateway",
    link: { label: "Connect a provider", href: "/docs/cloud/share-with-your-team/custom-llm-provider" }
  },
  {
    icon: "monitor",
    title: "One app for macOS, Windows, and Linux",
    link: { label: "Download", href: "/download" }
  },
  {
    icon: "users",
    title: "Share skills and MCP servers with everyone",
    link: { label: "Desktop policies", href: "/docs/cloud/share-with-your-team/desktop-policies" }
  }
];

export const claudeCoworkAlternativeFaq: FaqEntry[] = [
  {
    question: "Is there a free alternative to Claude Cowork?",
    answer: "Yes. OpenWork is a free, open-source desktop app for macOS, Windows, and Linux."
  },
  {
    question: "Does OpenWork work with local models?",
    answer: "Yes. Use Ollama, LM Studio, or any OpenAI-compatible server, and nothing leaves your computer."
  },
  {
    question: "Can I use my own API key or AI gateway?",
    answer: "Yes. Connect keys from 50+ providers, or add your company's OpenAI-compatible gateway as a custom provider."
  },
  {
    question: "Can I still use Claude models?",
    answer: "Yes. Add an Anthropic key and switch to any other model at any time."
  },
  {
    question: "Do my files stay on my computer?",
    answer: "Yes. In desktop mode files stay local and prompts go straight to the provider you pick."
  },
  {
    question: "How do I migrate from Claude Cowork?",
    answer:
      "Open the same folder in OpenWork and connect a model; SKILL.md skills, plugins, and MCP servers use the same formats. The migration guide covers each step."
  }
];

export const claudeCoworkAlternativeMarkdown = `# ${claudeCoworkAlternativeHeading}

> ${claudeCoworkAlternativeAnswer}

## OpenWork vs Claude Cowork

${compareMarkdownTable(comparisonColumns, comparisonRows)}

Sources: ${sourcesMarkdown(comparisonSources)}.

## Why people switch

${alternativeCards.map((card) => `- ${card.title}: [${card.link.label}](https://openworklabs.com${card.link.href})`).join("\n")}

## Cost

The page includes a calculator comparing Claude Team, Claude Enterprise, Claude Desktop on 3P, and OpenWork plans for your team size, usage, and models, using list API prices from models.dev. On Bedrock, Vertex, or Foundry? See [OpenWork vs Claude Cowork on 3P](https://openworklabs.com/alternatives/claude-cowork-3p).

## FAQ

${claudeCoworkAlternativeFaq.map((entry) => `### ${entry.question}\n${entry.answer}`).join("\n\n")}

## Next steps

- [Download OpenWork for free](https://openworklabs.com/download)
- [Migration guide](https://openworklabs.com${MIGRATION_GUIDE_PATH})
`;
