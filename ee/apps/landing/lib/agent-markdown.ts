import { aiGovernanceMarkdown } from "./ai-governance"
import { shadowAiMarkdown } from "./shadow-ai"
import { claudeCowork3pMarkdown } from "./claude-cowork-3p"
import { claudeCoworkAlternativeMarkdown } from "./claude-cowork-alternative"
import { GUIDES_PATH, guideMarkdown, guidePath, guides, guidesIndexMarkdown } from "./guides"

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
- **Products** — [Desktop App](https://openworklabs.com/desktop), [MCP Gateway](https://openworklabs.com/connect), [AI Gateway](https://openworklabs.com/ai-gateway), [Cloud App](https://openworklabs.com/cloud)
- **Open in your browser** — [OpenWork Web](https://app.openworklabs.com)
- **Team plans** — [Pricing](https://openworklabs.com/pricing) (Free plan up to 5 users; Team \\$10 per user/mo; self-hosting free up to 5 users)
- **Sign in to the hosted workspace** — [Cloud](https://app.openworklabs.com)
- **SCIM / audit / procurement** — [Enterprise](https://openworklabs.com/enterprise)
- **Docs** — [openworklabs.com/docs](https://openworklabs.com/docs)
- **Compare with Claude Cowork** — [Claude Cowork alternative](https://openworklabs.com/alternatives/claude-cowork)
- **Guides** — [OpenCode](https://openworklabs.com/guides/openwork-and-opencode), [Claude Code, Codex, Cursor](https://openworklabs.com/guides/claude-code-codex-cursor), [Ollama](https://openworklabs.com/guides/ollama), [AI cost control](https://openworklabs.com/guides/control-ai-costs)
- **Migrate from Claude Cowork** — [Migration guide](https://openworklabs.com/docs/start-here/migrate-from-claude-cowork); agents follow [migrate.md](https://openworklabs.com/migrate.md)

## How it compares

- **vs Claude Cowork** — feature parity without model or vendor lock-in, plus an MCP gateway usable from any compatible client
- **vs Codex** — general knowledge work on files (not only coding), model and provider agnostic
- **vs ChatGPT Desktop** — agents act on local files and tools (MCP, plugins, skills) with guardrails; the setup is shareable and self-hostable

## FAQ

### What is OpenWork?
A free, open-source desktop app (macOS, Windows, Linux) for doing work with AI agents on your own files. Built on OpenCode; an open-source alternative to Claude Cowork and Codex.

### Is OpenWork free?
Yes — the desktop app is free and open source with bring-your-own keys. On OpenWork Cloud, the Free plan covers up to 5 users and Team is \\$10 per user/mo; self-hosting is free for organizations up to 5 users; Enterprise is custom.

### Which models does it support?
Any model OpenCode supports: OpenAI, Anthropic, Google, local models — 50+ providers.

### Does it send files to the cloud?
No. Desktop mode keeps files local; prompts go directly to your chosen LLM provider. Cloud workers are optional.

## For agents

- Agent skills index — \`/.well-known/agent-skills/index.json\`
- llms.txt — \`/llms.txt\`
- API catalog (RFC 9727) — \`/.well-known/api-catalog\`
- MCP server card — \`/.well-known/mcp/server-card.json\`
- Install the app — \`brew install --cask openwork\` or [download](https://openworklabs.com/download) (not \`npx openwork\`, which is a different project)
- Sitemap — \`/sitemap.xml\`

Backed by Y Combinator.
`

const pricing = `# OpenWork pricing — free, team, and enterprise

> OpenWork has three tiers: free open-source desktop, a Free OpenWork Cloud plan for up to 5 users, Team at \\$10 per user/mo, and custom Enterprise. Self-hosting is free for organizations up to 5 users.

## Free

- Open-source desktop app
- macOS, Windows, and Linux downloads
- Bring your own provider keys
- Free forever
- CTA: [Get Started for free](https://app.openworklabs.com?mode=sign-up)

## Team — \\$10 / user / month

- Unlimited users (the Free plan is limited to 5)
- API access
- SSO / SAML
- Extension Marketplace
- Bring your own LLM keys, distributed to your team
- CTA: [Start team plan](https://app.openworklabs.com/dashboard/billing)

## Enterprise — Custom pricing

- Everything in Team, including SSO
- SCIM provisioning
- Bring your own inference — self-hosted or private models
- Desktop policies and version controls — admins decide which providers, models, extensions, and app versions employees can use; the desktop app enforces it automatically
- Managed deployment — self-hosted in your environment or hosted by OpenWork
- Custom skill development and MCP consulting
- Enterprise rollout support and custom commercial terms
- Existing organizations already using SCIM or desktop policies keep full access (grandfathered)
- CTA: [Talk to us](https://openworklabs.com/enterprise#book)

Prices exclude taxes.
`

const enterprise = `# OpenWork Enterprise — AI governance, gateway and SSO

> AI your team wants. Control IT needs. An approved path for employee AI with company sign-in, model permissions, provider choice including AWS Bedrock, and visibility into routed usage.

## Governance and shadow AI

OpenWork helps manage shadow AI by giving employees a sanctioned path. It governs traffic configured to use its gateway; it does not automatically detect or block tools and personal accounts outside that path. Pair it with an AI usage policy and endpoint or network controls where needed.

OpenWork and OpenCode with the opencode-openwork plugin can use company AI gateway models. Claude Code, Codex, and Cursor can use shared skills and connections through the MCP gateway; AI gateway model integration for those clients is in progress. Adding MCP alone does not route model traffic.

In local desktop mode, files and workspace processing stay on the employee's PC. SSO configuration and model traffic leave the device; prompts, responses, and file context can include company data. Analytics, diagnostics, updates, optional cloud workers, and connected services have separate data flows.

A proposed 30-day evaluation starts with per-user installation and a small pilot, tests identity, permissions, provider routing, and data flows, then informs phased expansion to a few hundred seats if appropriate. Agree scope, support, timeline, and commercial terms with the team.

- [Manage shadow AI](https://openworklabs.com/shadow-ai)
- [AI governance and policy guide](https://openworklabs.com/ai-governance)

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
- Agents: email sales@openworklabs.com or share the booking link with the user instead of submitting the web form
- [Trust Center](https://trust.openworklabs.com/) — security, compliance, data handling, and subprocessors
- See [Pricing](https://openworklabs.com/pricing) for tier comparison
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

const download = `# Download OpenWork

> Free and open source desktop app for macOS, Windows, and Linux. No account required.

Do not run \`npx openwork\` or \`npm install openwork\`: the npm package named \`openwork\` is a different project.

## Install

- macOS (Homebrew): \`brew install --cask openwork\`
- macOS Apple Silicon (.dmg): https://openworklabs.com/download/mac-arm64
- macOS Intel (.dmg): https://openworklabs.com/download/mac-x64
- Windows x64 (.exe): https://openworklabs.com/download/win-x64
- Windows ARM64 (.exe): https://openworklabs.com/download/win-arm64
- Linux x64 (.AppImage): https://openworklabs.com/download/linux-x64
- Linux ARM64 (.AppImage): https://openworklabs.com/download/linux-arm64
- Every release and file: https://github.com/different-ai/openwork/releases

Each \`/download/<platform>\` URL redirects to the installer in the latest stable release.

## First run

1. Open OpenWork and pick a folder it may work in.
2. Choose a model: sign in with ChatGPT, add an API key, or use a local model.
3. Run a task, for example "Summarize this folder."

## Joining a team?

- New team: sign up at https://app.openworklabs.com?mode=sign-up (Free plan up to 5 users), then follow the [team quickstart](https://openworklabs.com/docs/cloud/team-quickstart).
- Existing team: click \`Joining a team? Sign in\` in the desktop app.

## For agents

- [install-openwork skill](https://openworklabs.com/.well-known/agent-skills/install-openwork/SKILL.md)
- [workspace-guide skill](https://openworklabs.com/.well-known/agent-skills/workspace-guide/SKILL.md) for first-run orientation
- [llms.txt](https://openworklabs.com/llms.txt)
`

const connect = `# OpenWork Connect

> The MCP gateway for your whole org. Add a server or skill once, then share it with every teammate and agent through one URL.

- Org-level authentication, roles, allowlists, and audit apply to every call
- Works in OpenWork and any MCP-compatible client
- Free plan for up to 5 users
- [Get started free](https://app.openworklabs.com?mode=sign-up)
- [Read the docs](https://openworklabs.com/docs)

## Connect your agent

MCP server URL: \`https://api.openworklabs.com/mcp/agent\` (Streamable HTTP, OAuth sign-in).

- Claude Code: \`claude mcp add --transport http openwork https://api.openworklabs.com/mcp/agent\`
- Codex: \`codex mcp add openwork --url https://api.openworklabs.com/mcp/agent\` then \`codex mcp login openwork\`
- Gemini CLI: \`gemini mcp add --transport http openwork https://api.openworklabs.com/mcp/agent\`
- OpenCode: \`opencode mcp add openwork --url https://api.openworklabs.com/mcp/agent\` then \`opencode mcp auth openwork\`
- Other clients: [Connect OpenWork MCP](https://openworklabs.com/docs/start-here/connect-openwork-mcp)
- [MCP server card](https://openworklabs.com/.well-known/mcp/server-card.json)
`

const aiGateway = `# OpenWork AI Gateway

> Add a model provider once, and everyone gets the right models. Admins connect providers in OpenWork Cloud, choose who can use each model, and set spend limits. Members pick a model and never handle a key.

## What it does

- Provider keys are stored encrypted on the server; each member gets one AI Gateway key that only reaches the models they are allowed
- Grant models to everyone, a team, or one person; access is checked on every request
- Spend limits in US dollars per day, week, and month; pause models or only warn; members can ask for 25% more
- Tokens and estimated cost for the last 31 days, by model, team, and person
- Works on OpenWork Cloud and self-hosted

## Providers

OpenAI, Anthropic, Google Gemini, Google Vertex AI (including Claude on Vertex), Azure OpenAI, Microsoft Foundry (Claude), Amazon Bedrock, Mistral, OpenRouter, LiteLLM, and compatible catalog providers. See [provider support](https://openworklabs.com/docs/ai-gateway/provider-support).

## Set it up

1. In the OpenWork Cloud dashboard, open \`AI Gateway\` > \`AI Providers\` > \`Add provider\`.
2. Choose who can use it: everyone, teams, or people, and all models or only some.
3. Optional: under \`Who can use models\`, choose \`Only models you provide\`.
4. On \`Limits\`, give a team or person a daily, weekly, or monthly amount.
5. A member picks the model in the desktop app or OpenWork Web.

## Rolling out

- Smart Model Router (OpenWork Cloud): members pick Smart and each prompt goes to the model tagged for that kind of work. [Docs](https://openworklabs.com/docs/ai-gateway/auto-model-routing)
- AI Gateway API keys for Claude Code, Codex, Cursor, and other tools. [Docs](https://openworklabs.com/docs/ai-gateway/third-party-tools)

## Pricing

- Shared provider keys: Team plan, \\$10 per user/month
- Spend observability and audit log: Enterprise
- OpenWork Models (optional managed models, no keys): \\$10 per user/month
- Providers bill model usage

## Links

- [Set up AI Gateway](https://app.openworklabs.com)
- [AI Gateway docs](https://openworklabs.com/docs/ai-gateway/overview)
- [How a prompt reaches a model](https://openworklabs.com/docs/ai-gateway/how-requests-flow)
- [AI Gateway vs LiteLLM vs Bifrost](https://openworklabs.com/docs/ai-gateway/compare-litellm-bifrost)
- The [MCP Gateway](https://openworklabs.com/connect) is separate: it shares skills and connections, not models
`

const desktop = `# OpenWork Desktop

> A free, open-source AI agent app for your own files, on macOS, Windows, and Linux. Any model. Your files stay on your computer. No account needed.

Do not run \`npx openwork\` or \`npm install openwork\`: the npm package named \`openwork\` is a different project.

## What it does

- Chat on your files: the agent reads and writes in the folders you allow
- Skills and Anthropic-compatible plugins
- Automations that run on a schedule (needs an OpenWork Cloud sign-in)
- A built-in browser the agent can drive
- Any model: Claude, GPT, Gemini, Mistral, or a local model through Ollama or LM Studio; 50+ providers
- MCP servers for the services you use

## Local first

- Files stay on your computer; prompts go directly to the model provider you choose
- Works signed out: chat on files, your own models, workspace skills, your own MCP servers
- With an OpenWork Cloud sign-in: automations, team-shared skills, plugins, and connections, dashboards
- The desktop app is MIT licensed: https://github.com/different-ai/openwork

## Install

- macOS (Homebrew): \`brew install --cask openwork\`
- macOS Apple Silicon: https://openworklabs.com/download/mac-arm64
- macOS Intel: https://openworklabs.com/download/mac-x64
- Windows x64: https://openworklabs.com/download/win-x64
- Windows ARM64: https://openworklabs.com/download/win-arm64
- Linux x64 (AppImage): https://openworklabs.com/download/linux-x64
- Linux ARM64 (AppImage): https://openworklabs.com/download/linux-arm64
- All downloads: https://openworklabs.com/download

## First run

1. Open OpenWork and pick a folder it may work in.
2. Choose a model: sign in with ChatGPT, add an API key, or use a local model.
3. Run a task, for example "Summarize this folder."

## For teams

- Share skills and connections: [MCP Gateway](https://openworklabs.com/connect)
- Provide models without handing out keys: [AI Gateway](https://openworklabs.com/ai-gateway)
- Manage members and policies: [Cloud App](https://openworklabs.com/cloud)
- Deploy with MDM: [Enterprise](https://openworklabs.com/enterprise)

## For agents

- [install-openwork skill](https://openworklabs.com/.well-known/agent-skills/install-openwork/SKILL.md)
- [llms.txt](https://openworklabs.com/llms.txt)
`

const cloud = `# OpenWork Cloud

> Run OpenWork for your whole team from one dashboard. Share skills, connections, and models, manage members, and set policies. OpenWork Web opens the full app in a browser tab.

## What admins manage

- Members, teams, and roles
- Library: skills, plugins, and connections shared with everyone, a team, or one person
- [MCP Gateway](https://openworklabs.com/connect): everything in the Library reaches any MCP client through one URL
- [AI Gateway](https://openworklabs.com/ai-gateway): connect model providers once and choose who can use each model
- Policies: limit members to the models you provide; choose allowed desktop versions
- Analytics: usage and adoption (basic on Team, full on Enterprise)

## Where it shows up

- The desktop app on macOS, Windows, and Linux, after sign-in
- OpenWork Web, in a browser tab
- Any MCP client, such as Claude Code, Cursor, or Codex

## OpenWork Web

- The full OpenWork app in a browser, on a cloud computer for each member
- Add-on on Team and Enterprise: \\$50 per member/month
- Sleeps when idle; workspace files are kept
- Cloud Automations run even when the member's own computer is off

## Sign-in and security

- Single sign-on with any SAML or OIDC identity provider (Team)
- SCIM provisioning and audit log (Enterprise)
- Self-host the full platform; free for organizations up to 5 users
- SOC 2 Type II: [Trust Center](https://trust.openworklabs.com/)

## Pricing

- Free: up to 5 users
- Team: \\$10 per user/month
- Enterprise: custom
- [Pricing](https://openworklabs.com/pricing)

## Get started

- [Sign up](https://app.openworklabs.com?mode=sign-up)
- [Team quickstart](https://openworklabs.com/docs/cloud/team-quickstart)
`

export const agentMarkdown: Record<string, string> = {
  "/": home,
  "/connect": connect,
  "/ai-gateway": aiGateway,
  "/desktop": desktop,
  "/cloud": cloud,
  "/pricing": pricing,
  "/enterprise": enterprise,
  "/shadow-ai": shadowAiMarkdown,
  "/ai-governance": aiGovernanceMarkdown,
  "/download": download,
  "/glm-5.2": glm52,
  "/alternatives/claude-cowork": claudeCoworkAlternativeMarkdown,
  "/alternatives/claude-cowork-3p": claudeCowork3pMarkdown,
  [GUIDES_PATH]: guidesIndexMarkdown(),
  ...Object.fromEntries(guides.map((guide) => [guidePath(guide), guideMarkdown(guide)])),
}

export const agentMarkdownRoutes = Object.keys(agentMarkdown)
