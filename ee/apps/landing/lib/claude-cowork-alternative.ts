import type { FaqEntry } from "./faq";

export const CLAUDE_COWORK_ALTERNATIVE_PATH = "/alternatives/claude-cowork";
export const CLAUDE_COWORK_ALTERNATIVE_URL = `https://openworklabs.com${CLAUDE_COWORK_ALTERNATIVE_PATH}`;
export const MIGRATION_GUIDE_PATH = "/docs/start-here/migrate-from-claude-cowork";

export const claudeCoworkAlternativeAnswer =
  "OpenWork is a free, open-source desktop app that does what Claude Cowork does — an AI agent that works on your files, uses skills, and connects to your tools — without tying you to one model vendor. It runs on macOS, Windows, and Linux, works with 50+ model providers including local models through Ollama or LM Studio, and uses your own API keys. Teams can share skills and MCP servers with everyone from one place.";

export type ComparisonRow = {
  label: string;
  openwork: string;
  cowork: string;
};

// Keep the Claude Cowork column factual and neutral: describe what Anthropic
// offers, never claim a limitation we cannot verify.
export const comparisonRows: ComparisonRow[] = [
  {
    label: "Price",
    openwork: "Free desktop app. Optional paid team plans.",
    cowork: "Included with paid Claude plans"
  },
  {
    label: "Source code",
    openwork: "Open source on GitHub",
    cowork: "Proprietary"
  },
  {
    label: "Platforms",
    openwork: "macOS, Windows, and Linux",
    cowork: "Claude desktop app on macOS and Windows"
  },
  {
    label: "Models",
    openwork: "50+ providers: Anthropic, OpenAI, Google, Mistral, OpenRouter, and more",
    cowork: "Anthropic Claude models"
  },
  {
    label: "Local models",
    openwork: "Ollama, LM Studio, or any OpenAI-compatible server",
    cowork: "Runs on Anthropic's cloud"
  },
  {
    label: "Billing and keys",
    openwork: "Your own API keys or your company's AI gateway",
    cowork: "Claude subscription"
  },
  {
    label: "Skills and plugins",
    openwork: "SKILL.md skills and Claude-compatible plugins",
    cowork: "SKILL.md skills and plugins"
  },
  {
    label: "Share skills and MCP servers",
    openwork: "Publish once, every teammate gets them in one click",
    cowork: "Managed within Claude team plans"
  },
  {
    label: "Self-host",
    openwork: "Files stay local; self-host the team control plane",
    cowork: "Hosted by Anthropic"
  }
];

export type AlternativeSection = {
  title: string;
  body: string;
  link: { label: string; href: string };
};

export const alternativeSections: AlternativeSection[] = [
  {
    title: "Run with local models",
    body: "Point OpenWork at Ollama, LM Studio, or any OpenAI-compatible server on your machine, so prompts and files stay on your computer.",
    link: {
      label: "Add a local or custom model",
      href: "/docs/start-here/connect-your-stack/add-a-custom-llm"
    }
  },
  {
    title: "Bring your own key or AI gateway",
    body: "Use API keys from Anthropic, OpenAI, Google Gemini and Vertex, Mistral, OpenRouter, Fireworks, Azure, and more — or route every request through your company's OpenAI-compatible gateway.",
    link: {
      label: "Share a custom provider with your team",
      href: "/docs/cloud/share-with-your-team/custom-llm-provider"
    }
  },
  {
    title: "macOS, Windows, and Linux",
    body: "One desktop app for every operating system your team uses, with no terminal required. No account is needed to download.",
    link: { label: "Download OpenWork", href: "/download" }
  },
  {
    title: "Built for teams",
    body: "Publish skills and MCP servers once and every teammate gets them. Set desktop policies for which models and extensions people can use, or self-host the whole stack.",
    link: {
      label: "Set desktop policies",
      href: "/docs/cloud/share-with-your-team/desktop-policies"
    }
  }
];

export const claudeCoworkAlternativeFaq: FaqEntry[] = [
  {
    question: "Is there a free alternative to Claude Cowork?",
    answer:
      "Yes. OpenWork is a free, open-source desktop app for macOS, Windows, and Linux. You bring your own model provider keys or run local models, so there is no subscription required to use it."
  },
  {
    question: "Can I use OpenWork with local models like Ollama or LM Studio?",
    answer:
      "Yes. OpenWork works with Ollama, LM Studio, and any OpenAI-compatible server running on your machine, so prompts and files stay on your computer."
  },
  {
    question: "Can I use my own API key or AI gateway?",
    answer:
      "Yes. Connect keys from Anthropic, OpenAI, Google, Mistral, OpenRouter, Azure, and 50+ other providers, or add your company's OpenAI-compatible gateway as a custom provider. Requests go directly to the provider you choose."
  },
  {
    question: "Does OpenWork run on Linux?",
    answer:
      "Yes. OpenWork has desktop builds for Linux, Windows, and macOS."
  },
  {
    question: "Do my files stay on my computer?",
    answer:
      "Yes. In desktop mode your files stay on your machine and prompts go straight to the model provider you pick. With a local model, nothing leaves your computer. Cloud features are optional."
  },
  {
    question: "Can I use Claude models in OpenWork?",
    answer:
      "Yes. Add an Anthropic API key to use Claude models, and switch to any other provider at any time."
  },
  {
    question: "How do I migrate from Claude Cowork to OpenWork?",
    answer:
      "Open the same folder as an OpenWork workspace, connect a model, then bring over your SKILL.md skills, plugins, and MCP servers — they use the same formats. The migration guide at openworklabs.com/docs/start-here/migrate-from-claude-cowork walks through each step."
  }
];

export const claudeCoworkAlternativeMarkdown = `# The free, open-source alternative to Claude Cowork

> ${claudeCoworkAlternativeAnswer}

## OpenWork vs Claude Cowork

| | OpenWork | Claude Cowork |
|---|---|---|
${comparisonRows.map((row) => `| ${row.label} | ${row.openwork} | ${row.cowork} |`).join("\n")}

Claude Cowork details summarize Anthropic's public product information; check Anthropic's site for current plans.

${alternativeSections
  .map((section) => `## ${section.title}\n\n${section.body}\n\n- [${section.link.label}](https://openworklabs.com${section.link.href})`)
  .join("\n\n")}

## Cost

An interactive calculator on this page compares Claude Team, Claude Enterprise, Claude Desktop on 3P, OpenWork Team, and OpenWork Enterprise for your team size, usage, and models, using list API prices from models.dev. Teams running Claude Desktop on Bedrock, Vertex, or Foundry: see [OpenWork vs Claude Cowork on 3P](https://openworklabs.com/alternatives/claude-cowork-3p).

## FAQ

${claudeCoworkAlternativeFaq.map((entry) => `### ${entry.question}\n${entry.answer}`).join("\n\n")}

## Next steps

- [Download OpenWork for free](https://openworklabs.com/download)
- [Migration guide](https://openworklabs.com${MIGRATION_GUIDE_PATH})
- [Docs](https://openworklabs.com/docs)
`;
