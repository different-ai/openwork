import type { FaqEntry } from "./faq";

export const CLAUDE_COWORK_3P_PATH = "/alternatives/claude-cowork-3p";
export const CLAUDE_COWORK_3P_URL = `https://openworklabs.com${CLAUDE_COWORK_3P_PATH}`;

/** Date the Anthropic 3P facts were checked against Anthropic's public docs. */
export const anthropic3pCheckedAt = "2026-09-25";

export const anthropic3pSources = [
  { label: "Claude Desktop on 3P overview", href: "https://claude.com/docs/third-party/claude-desktop/overview" },
  { label: "3P feature matrix", href: "https://claude.com/docs/third-party/claude-desktop/feature-matrix" },
  { label: "3P models", href: "https://claude.com/docs/third-party/claude-desktop/models" },
  { label: "Claude Enterprise pricing", href: "https://claude.com/pricing/enterprise" }
];

export const claudeCowork3pAnswer =
  "Claude Desktop on third-party platforms (3P) lets you run Claude Cowork against Amazon Bedrock, Google Cloud Agent Platform (Vertex), Microsoft Foundry, or your own gateway, with no seat fee. It only offers Claude models, and Anthropic's feature matrix lists plugin and project sharing, web, and mobile as unavailable on 3P. OpenWork keeps your gateway and cloud commitments, adds any model from 50+ providers, and gives you a control plane to share skills and MCP servers with every teammate.";

export type ThreeWayRow = {
  label: string;
  enterprise: string;
  thirdParty: string;
  openwork: string;
};

// Anthropic cells come from Anthropic's 3P overview, feature matrix, models,
// and Enterprise pricing pages (see anthropic3pSources). OpenWork cells are
// verified against this repository's docs and pricing.
export const threeWayRows: ThreeWayRow[] = [
  {
    label: "Pricing",
    enterprise: "$20 per seat / month billed annually, plus all usage at API rates",
    thirdParty: "No seat licensing; tokens billed by your cloud provider",
    openwork: "$40 per user / month (Enterprise) or $10 (Team); tokens at your provider's price"
  },
  {
    label: "Models",
    enterprise: "Claude models",
    thirdParty: "Claude model IDs only",
    openwork: "Any model: Claude, GPT, Gemini, DeepSeek, GLM, Qwen, and 50+ providers"
  },
  {
    label: "Where inference runs",
    enterprise: "Anthropic",
    thirdParty: "Bedrock, Vertex, Microsoft Foundry, a gateway implementing the Anthropic Messages API, or the Anthropic API",
    openwork: "Bedrock, Vertex, Azure Foundry, any OpenAI-compatible gateway, local models, or managed OpenWork Models"
  },
  {
    label: "Agent work on files, chat, and code",
    enterprise: "Available",
    thirdParty: "Available (Chat, Cowork, Code)",
    openwork: "Available"
  },
  {
    label: "Scheduled tasks",
    enterprise: "Available",
    thirdParty: "Available",
    openwork: "Available (alpha)"
  },
  {
    label: "Skills, plugins, and MCP servers",
    enterprise: "Available",
    thirdParty: "Available, including plugin marketplaces",
    openwork: "SKILL.md skills, Claude-compatible plugins, local and remote MCP servers"
  },
  {
    label: "Share plugins and projects with your team",
    enterprise: "Available",
    thirdParty: "Not available",
    openwork: "Publish once, assign to teams and members from OpenWork Cloud"
  },
  {
    label: "Browser access",
    enterprise: "claude.ai on the web",
    thirdParty: "Not available",
    openwork: "OpenWork Web (hosted add-on)"
  },
  {
    label: "Mobile app",
    enterprise: "Available",
    thirdParty: "Not available",
    openwork: "Not yet; on the roadmap"
  },
  {
    label: "Analytics and audit",
    enterprise: "Analytics API and Compliance API",
    thirdParty: "OpenTelemetry export; no Analytics or Compliance API",
    openwork: "Usage, adoption, and spend analytics plus audit log (Enterprise)"
  },
  {
    label: "Admin and deployment",
    enterprise: "Anthropic-hosted",
    thirdParty: "MDM profile, bootstrap server, or Anthropic-hosted admin console",
    openwork: "OpenWork Cloud, or self-host with Helm or Docker Compose; policies, skills, and MCP connections reach every seat from there"
  },
  {
    label: "New features",
    enterprise: "Ship first on Team and Enterprise",
    thirdParty: "Arrive later than on Team and Enterprise",
    openwork: "Open source with a public changelog"
  }
];

export type ThreePSection = {
  title: string;
  body: string;
  links: { label: string; href: string }[];
};

export const threePSections: ThreePSection[] = [
  {
    title: "Keep your gateway and committed spend. Use any model.",
    body: "Point OpenWork at the same Bedrock, Vertex, or Foundry accounts you already pay for, or at your internal gateway. Then route routine work to open-weight or other vendors' models to bring token costs down, without giving up Claude where it matters.",
    links: [
      { label: "Google Agent Platform (Vertex)", href: "/docs/ai-gateway/google-agent-platform" },
      { label: "Add a custom provider or gateway", href: "/docs/cloud/share-with-your-team/custom-llm-provider" },
      { label: "Per-member gateway keys", href: "/docs/cloud/share-with-your-team/per-member-llm-credentials" }
    ]
  },
  {
    title: "Share skills and MCP servers without hand-built profiles",
    body: "Publish a skill or plugin once and assign it to a team. Add an MCP connection once and let each person sign in as themselves. No redeploying device profiles every time a server is added, and no internal skill library to maintain.",
    links: [
      { label: "Publish and copy a skill", href: "/docs/start-here/do-work-with-it/publish-and-copy-a-skill" },
      { label: "Share MCP connections", href: "/docs/cloud/share-with-your-team/shared-mcp-connections" },
      { label: "Collections", href: "/docs/cloud/share-with-your-team/collections" }
    ]
  },
  {
    title: "Desktop and web, with a real control plane",
    body: "OpenWork Cloud manages members, providers, extensions, and desktop policies in one place, and the desktop app applies them automatically. Add OpenWork Web for browser access, or self-host the whole stack in your own cloud.",
    links: [
      { label: "Desktop policies", href: "/docs/cloud/share-with-your-team/desktop-policies" },
      { label: "Open OpenWork Web", href: "/docs/cloud/run-in-the-cloud/open-cloud-in-browser" },
      { label: "Self-host", href: "/docs/start-here/self-host" }
    ]
  },
  {
    title: "A gradual migration path",
    body: "Your SKILL.md skills, plugins, and MCP servers carry over. Roll out the OpenWork Enterprise binary with your existing software distribution, and keep Claude Desktop running while teams switch. The OpenWork MCP Gateway also brings your organization's skills and connections into Claude Desktop in the meantime.",
    links: [
      { label: "Migrate from Claude Cowork", href: "/docs/start-here/migrate-from-claude-cowork" },
      { label: "Enterprise desktop deployment", href: "/docs/start-here/enterprise-desktop-deployment" },
      { label: "OpenWork MCP Gateway", href: "/docs/cloud/run-in-the-cloud/cloud-mcp" }
    ]
  }
];

export const claudeCowork3pFaq: FaqEntry[] = [
  {
    question: "What is Claude Desktop on 3P?",
    answer:
      "It is Anthropic's Claude Desktop, including Cowork, configured to send inference to Amazon Bedrock, Google Cloud Agent Platform (Vertex), Microsoft Foundry, a self-hosted gateway that implements the Anthropic Messages API, or the Anthropic API. Tokens are billed by your cloud provider with no seat licensing, and the model picker only offers Claude models."
  },
  {
    question: "Can OpenWork use my Bedrock, Vertex, or Foundry account?",
    answer:
      "Yes. OpenWork connects to Amazon Bedrock, Google Vertex (Agent Platform), and Azure Foundry, as well as any OpenAI-compatible gateway, so your existing cloud commitments keep applying. You can also add non-Claude models from the same accounts or other providers."
  },
  {
    question: "Is OpenWork cheaper than Claude Desktop on 3P?",
    answer:
      "Not on seats: Claude Desktop on 3P has no seat fee, and OpenWork Enterprise is $40 per user per month. Tokens usually cost far more than seats, so the total depends on which models you use. Routing routine work to lower-cost models is where OpenWork can reduce spend; use the calculator on this page with your own numbers."
  },
  {
    question: "How do we share skills and MCP servers with the whole company?",
    answer:
      "Admins publish skills and plugins in OpenWork Cloud and assign them to teams or members. MCP connections are added once and each person signs in with their own account. Desktop policies control which providers, models, and extensions people can use."
  },
  {
    question: "Can we self-host OpenWork?",
    answer:
      "Yes. The OpenWork control plane can be self-hosted with a Helm chart or evaluated with Docker Compose, and the Enterprise price is the same cloud or self-hosted."
  },
  {
    question: "Does OpenWork have a mobile app?",
    answer:
      "Not yet. Mobile is on the public roadmap. Today OpenWork runs on macOS, Windows, and Linux, and in the browser with OpenWork Web."
  },
  {
    question: "Can we keep Claude Desktop while we evaluate OpenWork?",
    answer:
      "Yes. Your SKILL.md skills, plugins, and MCP servers work in both, and the OpenWork MCP Gateway can bring your organization's skills and connections into Claude Desktop as well."
  }
];

export const claudeCowork3pMarkdown = `# OpenWork vs Claude Cowork on 3P (Bedrock, Vertex, Foundry)

> ${claudeCowork3pAnswer}

## Claude Enterprise vs Claude Desktop on 3P vs OpenWork

| | Claude Enterprise | Claude Desktop on 3P | OpenWork |
|---|---|---|---|
${threeWayRows.map((row) => `| ${row.label} | ${row.enterprise} | ${row.thirdParty} | ${row.openwork} |`).join("\n")}

Anthropic details from Anthropic's public docs as of ${anthropic3pCheckedAt}: ${anthropic3pSources.map((source) => `[${source.label}](${source.href})`).join(", ")}.

${threePSections
  .map(
    (section) =>
      `## ${section.title}\n\n${section.body}\n\n${section.links.map((link) => `- [${link.label}](https://openworklabs.com${link.href})`).join("\n")}`
  )
  .join("\n\n")}

## Cost

An interactive calculator on this page compares Claude Team, Claude Enterprise, Claude Desktop on 3P, OpenWork Team, and OpenWork Enterprise for your team size, usage, and models, using list API prices from models.dev.

## FAQ

${claudeCowork3pFaq.map((entry) => `### ${entry.question}\n${entry.answer}`).join("\n\n")}

## Next steps

- [Talk to us about Enterprise](https://openworklabs.com/enterprise#book)
- [Claude Cowork alternative overview](https://openworklabs.com/alternatives/claude-cowork)
- [Self-host](https://openworklabs.com/docs/start-here/self-host)
`;
