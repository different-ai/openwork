import type { CompareCard, CompareColumn, CompareRow, CompareSource } from "./compare";
import { compareMarkdownTable, sourcesMarkdown } from "./compare";
import type { FaqEntry } from "./faq";

export const CLAUDE_COWORK_3P_PATH = "/alternatives/claude-cowork-3p";
export const CLAUDE_COWORK_3P_URL = `https://openworklabs.com${CLAUDE_COWORK_3P_PATH}`;

/** Date the Anthropic 3P facts were checked against Anthropic's public docs. */
export const anthropic3pCheckedAt = "2026-09-25";

export const anthropic3pSources: CompareSource[] = [
  { label: "3P overview", href: "https://claude.com/docs/third-party/claude-desktop/overview" },
  { label: "3P feature matrix", href: "https://claude.com/docs/third-party/claude-desktop/feature-matrix" },
  { label: "3P models", href: "https://claude.com/docs/third-party/claude-desktop/models" },
  { label: "Claude Enterprise pricing", href: "https://claude.com/pricing/enterprise" }
];

export const claudeCowork3pHeading = "OpenWork vs Claude Cowork on 3P";

/** Hero sub-line. Keep it under 20 words. */
export const claudeCowork3pAnswer =
  "Keep Bedrock, Vertex, or Foundry. Add any model, and share skills and MCP servers with every teammate.";

export type ThreeWayColumnKey = "enterprise" | "thirdParty" | "openwork";

export const threeWayColumns: CompareColumn<ThreeWayColumnKey>[] = [
  { key: "enterprise", label: "Claude Enterprise" },
  { key: "thirdParty", label: "Claude on 3P" },
  { key: "openwork", label: "OpenWork" }
];

// Anthropic cells come from Anthropic's 3P overview, feature matrix, models,
// and Enterprise pricing pages (see anthropic3pSources). OpenWork cells are
// verified against this repository's docs and pricing.
export const threeWayRows: CompareRow<ThreeWayColumnKey>[] = [
  { label: "Seat price / month", enterprise: "$20 + usage", thirdParty: "None", openwork: "$10–$40" },
  { label: "Non-Claude models", enterprise: false, thirdParty: false, openwork: true },
  { label: "Bedrock, Vertex, Foundry", enterprise: false, thirdParty: true, openwork: true },
  { label: "Share plugins with your team", enterprise: true, thirdParty: false, openwork: true },
  { label: "Browser access", enterprise: true, thirdParty: false, openwork: "Alpha" },
  { label: "Mobile app", enterprise: true, thirdParty: false, openwork: false },
  { label: "Usage analytics and audit", enterprise: true, thirdParty: "Export only", openwork: true },
  { label: "Self-host the control plane", enterprise: false, thirdParty: false, openwork: true }
];

export const threePCards: CompareCard[] = [
  {
    icon: "cloud",
    title: "Keep your cloud account and committed spend",
    link: { label: "Connect Vertex", href: "/docs/ai-gateway/google-agent-platform" }
  },
  {
    icon: "route",
    title: "Send routine work to lower-cost models",
    link: { label: "Add a gateway", href: "/docs/cloud/share-with-your-team/custom-llm-provider" }
  },
  {
    icon: "library",
    title: "Share skills and MCP servers without MDM profiles",
    link: { label: "Publish a skill", href: "/docs/start-here/do-work-with-it/publish-and-copy-a-skill" }
  },
  {
    icon: "migrate",
    title: "Run alongside Claude Desktop while teams switch",
    link: { label: "Migration guide", href: "/docs/start-here/migrate-from-claude-cowork" }
  }
];

export const claudeCowork3pFaq: FaqEntry[] = [
  {
    question: "What is Claude Desktop on 3P?",
    answer:
      "Claude Desktop, including Cowork, sending inference to Bedrock, Vertex, Foundry, or your own gateway. There is no seat fee, and only Claude models are available."
  },
  {
    question: "Can OpenWork use my Bedrock, Vertex, or Foundry account?",
    answer: "Yes, plus any OpenAI-compatible gateway. Your existing cloud commitments keep applying."
  },
  {
    question: "Is OpenWork cheaper than Claude Desktop on 3P?",
    answer:
      "Not on seats: 3P has none, and OpenWork Enterprise is $40 per user. Savings come from routing work to lower-cost models, so check the calculator with your numbers."
  },
  {
    question: "How do we share skills and MCP servers?",
    answer: "Admins publish them once in OpenWork Cloud and assign them to teams. Each person signs in to MCP connections as themselves."
  },
  {
    question: "Can we self-host OpenWork?",
    answer: "Yes, with Helm or Docker Compose. Enterprise costs the same cloud or self-hosted."
  },
  {
    question: "Does OpenWork have a mobile app?",
    answer: "Not yet; it is on the public roadmap. OpenWork runs on macOS, Windows, Linux, and in the browser."
  }
];

export const claudeCowork3pMarkdown = `# ${claudeCowork3pHeading} (Bedrock, Vertex, Foundry)

> ${claudeCowork3pAnswer}

## Claude Enterprise vs Claude Desktop on 3P vs OpenWork

${compareMarkdownTable(threeWayColumns, threeWayRows)}

Anthropic details as of ${anthropic3pCheckedAt}: ${sourcesMarkdown(anthropic3pSources)}.

## Why teams on 3P switch

${threePCards.map((card) => `- ${card.title}: [${card.link.label}](https://openworklabs.com${card.link.href})`).join("\n")}

## Cost

The page includes a calculator comparing Claude Team, Claude Enterprise, Claude Desktop on 3P, and OpenWork plans for your team size, usage, and models, using list API prices from models.dev.

## FAQ

${claudeCowork3pFaq.map((entry) => `### ${entry.question}\n${entry.answer}`).join("\n\n")}

## Next steps

- [Talk to us about Enterprise](https://openworklabs.com/enterprise#book)
- [Download OpenWork](https://openworklabs.com/download)
- [Claude Cowork alternative overview](https://openworklabs.com/alternatives/claude-cowork)
`;
