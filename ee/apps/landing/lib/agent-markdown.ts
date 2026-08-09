const home = `# OpenWork

> The open-source Claude Cowork alternative. Chat on files, use skills, schedule tasks, automate a browser, and run on any model — plus an MCP gateway for your whole team.

## What it is

- Free, open-source desktop app for macOS, Windows, and Linux
- Any model or provider: Claude, GPT, Gemini, Mistral, local models, and 50+ providers
- Chat on files, browser automation, scheduled tasks, skills, and Anthropic-compatible plugins
- OpenWork Connect: one MCP gateway URL for org-wide skills, servers, roles, and policies
- OpenWork Web in alpha; central management and private deployment options for teams
- Coming soon: Dispatch (assign tasks from your phone) and live artifacts (auto-refreshing dashboards)

## Primary calls-to-action

- **Download for free** — [Desktop](https://openworklabs.com/download)
- **Open in your browser** — [OpenWork Web](https://app.openworklabs.com)
- **Team plans** — [Pricing](https://openworklabs.com/pricing) (first 5 seats free, then \\$10 per seat/mo)
- **Sign in to the hosted workspace** — [Cloud](https://app.openworklabs.com)
- **SSO / audit / procurement** — [Enterprise](https://openworklabs.com/enterprise)
- **Docs** — [openworklabs.com/docs](https://openworklabs.com/docs)
- **Migrate from Claude Cowork** — [Migration guide](https://openworklabs.com/docs/start-here/migrate-from-claude-cowork)

## How it compares

- **vs Claude Cowork** — feature parity without model or vendor lock-in, plus an MCP gateway usable from any compatible client
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

const glm52 = `# GLM 5.2 is now in OpenWork — with 2x usage

> GLM 5.2 is available through OpenWork Models, and we're doubling your usage so you can run real agent work on an open model at a fraction of the cost.

## What's new

- **GLM 5.2 in OpenWork Models** — managed OSS model access with 2x usage, no keys required
- **Run your day from chat** — tasks organize into In progress / Done / Requires attention; move them by asking
- **Split screen** — two windows side by side, less tab-switching
- **Voice mode** — control the OpenWork UI by voice
- **Advanced analytics on OpenWork Cloud** — usage, activity, and team behavior in one view

## How it works

1. **Sign up** — [Get Started for free](https://app.openworklabs.com?mode=sign-up&intent=models)
2. **Subscribe** — OpenWork Models at $10/user/mo includes GLM 5.2 with 2x usage
3. **Open the app** — switch to GLM 5.2 from the model picker

## What to try first

Open OpenWork, switch to GLM 5.2, and ask the chat to organize your tasks.

## Links

- [Try GLM 5.2 in OpenWork](https://app.openworklabs.com?mode=sign-up&intent=models)
- [Download the app](https://openworklabs.com/download)
- [Full changelog](https://openworklabs.com/docs/changelog)
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

const connect = `# OpenWork Connect

> The MCP gateway for your whole org. Add a server or skill once, then share it with every teammate and agent through one URL.

- Org-level authentication, roles, allowlists, and audit apply to every call
- Works in OpenWork and any MCP-compatible client
- First 5 seats are free
- [Get started free](https://app.openworklabs.com?mode=sign-up)
- [Read the docs](https://openworklabs.com/docs)
`

const cloud = `# OpenWork Cloud

> The dashboard for running OpenWork across your organization.

- Provision model providers centrally
- Deploy skills and MCP servers to every seat
- Manage members, policies, usage, and audit
- OpenWork Web and the Connect MCP gateway are built in
- [Get started free](https://app.openworklabs.com?mode=sign-up)
- [Explore Connect](https://openworklabs.com/connect)
`

export const agentMarkdown: Record<string, string> = {
  "/": home,
  "/connect": connect,
  "/cloud": cloud,
  "/pricing": pricing,
  "/enterprise": enterprise,
  "/download": download,
  "/trust": trust,
  "/glm-5.2": glm52,
}

export const agentMarkdownRoutes = Object.keys(agentMarkdown)
