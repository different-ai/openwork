const home = `# OpenWork

> The open-source Claude Cowork alternative. OpenWork is a desktop app that lets teams chat with 50+ LLMs, bring their own provider keys, and ship reusable agent setups with guardrails.

## What it is

- Desktop app (macOS, Windows, Linux) — GUI for OpenCode
- Bring your own model and provider (OpenAI, Anthropic, local models, 50+ supported)
- Skills, plugins, and MCP servers extend what the agent can do
- Shared agent setups for teams, with policy and guardrails
- Free and open source

## Primary calls-to-action

- **Try it free** — [Get Started for free](https://app.openworklabs.com?mode=sign-up)
- **Team plans** — [Pricing](https://openworklabs.com/pricing) (first 5 seats free, then \\$10 per seat/mo)
- **Sign in to the hosted workspace** — [Cloud](https://app.openworklabs.com)
- **SSO / audit / procurement** — [Enterprise](https://openworklabs.com/enterprise)
- **Docs** — [openworklabs.com/docs](https://openworklabs.com/docs)

## How it compares

- **vs Claude Cowork** — open source, 50+ LLMs from any provider, local-first (files stay on your machine), one-link team sharing of agent setups
- **vs Codex** — general knowledge work on files (not only coding), model and provider agnostic
- **vs ChatGPT Desktop** — agents act on local files and tools (MCP, plugins, skills) with guardrails; the setup is shareable and self-hostable

## FAQ

### What is OpenWork?
A free, open-source desktop app (macOS, Windows, Linux) for doing work with AI agents on your own files. Built on OpenCode; an open-source alternative to Claude Cowork and Codex.

### Is OpenWork free?
Yes — the desktop app is free and open source with bring-your-own keys. Team Starter includes your first 5 seats free, then \\$10 per seat/mo; Enterprise is custom.

### Which models does it support?
Any model OpenCode supports: OpenAI, Anthropic, Google, local models — 50+ providers.

### Does it send files to the cloud?
No. Desktop mode keeps files local; prompts go directly to your chosen LLM provider. Cloud workers are optional.

## For agents

- Agent skills index — \`/.well-known/agent-skills/index.json\`
- llms.txt — \`/llms.txt\`
- API catalog (RFC 9727) — \`/.well-known/api-catalog\`
- Sitemap — \`/sitemap.xml\`

Backed by Y Combinator.
`

const pricing = `# OpenWork pricing — free, team, and enterprise

> OpenWork has three tiers: free open-source desktop, Team Starter with the first 5 seats free then \\$10 per seat/mo, and custom Enterprise.

## Solo — Free

- Open-source desktop app
- macOS and Linux downloads
- Bring your own provider keys
- Free forever
- CTA: [Get Started for free](https://app.openworklabs.com?mode=sign-up)

## Team Starter — \\$10 / seat / month

- First 5 seats free
- API access
- Extension Marketplace
- Bring your own LLM keys, distributed to your team
- CTA: [Start team plan](https://app.openworklabs.com/dashboard/billing)

## Enterprise — Custom pricing

- Everything in Team Starter
- SSO / SAML and SCIM provisioning
- Bring your own inference — self-hosted or private models
- Desktop policies and version controls — admins decide which providers, models, extensions, and app versions employees can use; the desktop app enforces it automatically
- Managed deployment — self-hosted in your environment or hosted by OpenWork
- Custom skill development and MCP consulting
- Enterprise rollout support and custom commercial terms
- Existing organizations already using SSO or desktop policies keep full access (grandfathered)
- CTA: [Talk to us](https://openworklabs.com/enterprise#book)

Prices exclude taxes.
`

const enterprise = `# A privacy-first alternative to Claude Cowork for your organization

> The open-source Claude Cowork alternative — self-hosted, permissioned, and compliance-ready. SSO, audit, custom deployment, and procurement support.

## What Enterprise includes

- SSO / SAML integration and SCIM provisioning
- Desktop policies and version controls — guardrails for providers, models, extensions, and app versions, enforced by the desktop app
- Managed deployment — self-hosted in your environment or hosted by OpenWork
- Custom skill development for your team's workflows
- MCP consulting — connect internal data sources and tools as MCP servers
- Enterprise rollout support and custom commercial terms
- Named security contact and incident response

## Deployment models

- Self-hosted desktop app — data stays local, bring your own keys
- Cloud workers — managed by OpenWork, sandbox infrastructure via Daytona (EU)

## Next step

- [Book a call](https://openworklabs.com/enterprise#book)
- [Security Review](https://openworklabs.com/trust) — data handling, subprocessors, and incident SLA
- See [Pricing](https://openworklabs.com/pricing) for tier comparison
`

const download = `# Get Started with OpenWork

> Create a free OpenWork Cloud account first, then use the guided desktop app access flow.

## Start here

- [Get Started for free](https://app.openworklabs.com?mode=sign-up)
- Create or select your workspace.
- Follow the Cloud app's desktop app access flow.

## Supported platforms

- macOS
- Windows
- Linux

## After signing up

Once the desktop app is running, use the [workspace-guide skill](https://openworklabs.com/.well-known/agent-skills/workspace-guide/SKILL.md) for first-run orientation.
`

const trust = `# Trust & Security

> How OpenWork handles data, what subprocessors are involved, and how to reach the security team.

## Key facts

- **Deployment** — self-hosted desktop app on your machines
- **Data storage** — local-only, nothing leaves your machine in desktop mode
- **LLM keys** — bring your own, sent directly to your provider
- **Telemetry** — none in desktop mode; opt-in feedback only
- **Incident SLA** — 72hr notify, 3-day ack, 7-day triage
- **Subprocessors** — 5 named vendors (cloud & website only)

## Data handling

| Data type | Self-hosted | Cloud |
|---|---|---|
| Source code | Local only | Accessed at runtime via your LLM provider; not stored |
| LLM API keys | Local keychain / env vars | Held by your LLM provider, not by OpenWork |
| Prompts & responses | Local only | Sent to your LLM provider; not logged by OpenWork |
| Usage telemetry | None | Anonymous via PostHog; can be disabled |
| Authentication | Your SSO / SAML | Google or GitHub OAuth |

## Subprocessors

- PostHog — analytics (US/EU)
- Polar — billing (US)
- Google — OAuth (US)
- GitHub — OAuth (US)
- Daytona — cloud sandbox infrastructure (EU)

## Security contact

Omar McAdam — team+security@openworklabs.com
`

export const agentMarkdown: Record<string, string> = {
  "/": home,
  "/pricing": pricing,
  "/enterprise": enterprise,
  "/download": download,
  "/trust": trust,
}

export const agentMarkdownRoutes = Object.keys(agentMarkdown)
