import type { CompareCard } from "./compare";
import type { FaqEntry } from "./faq";

/**
 * Answer-first guide pages for search engines and AI answer engines (SEO / GEO / AEO).
 *
 * Each guide renders as HTML at /guides/<slug>, as Markdown for agents that send
 * `Accept: text/markdown` (see middleware.ts), and as FAQPage + Article JSON-LD.
 * Keep the short answer under ~45 words: it is the passage answer engines quote.
 */

export const SITE_URL = "https://openworklabs.com";
export const GUIDES_PATH = "/guides";

const MCP_URL = "https://api.openworklabs.com/mcp/agent";

export type GuideStep = {
  title: string;
  body: string;
  code?: string;
};

export type GuideTable = {
  caption: string;
  columns: string[];
  rows: string[][];
};

export type GuideSection = {
  id: string;
  heading: string;
  /** Short status label shown next to the heading, e.g. "In preview". */
  badge?: string;
  paragraphs?: string[];
  bullets?: string[];
  steps?: GuideStep[];
  table?: GuideTable;
};

export type Guide = {
  slug: string;
  /** Short label for the guides index and footer. */
  label: string;
  /** <title>; keep under 60 characters. */
  title: string;
  /** Meta description; keep under 160 characters. */
  description: string;
  /** The question the page answers, phrased the way people ask it. */
  heading: string;
  /** Short, quotable answer shown under the heading. */
  answer: string;
  /** ISO date of the last factual review. Shown on the page and in Article JSON-LD. */
  updated: string;
  /** Concrete, verifiable facts (numbers, names, limits). Answer engines cite specifics. */
  keyFacts: string[];
  sections: GuideSection[];
  cards: CompareCard[];
  faq: FaqEntry[];
  cta: {
    heading: string;
    sub: string;
    primary: { label: string; href: string };
    secondary: { label: string; href: string };
  };
};

export const guides: Guide[] = [
  {
    slug: "openwork-and-opencode",
    label: "OpenWork and OpenCode",
    title: "How OpenWork works with OpenCode",
    description:
      "OpenWork is built on OpenCode. Use the OpenWork desktop app, or add the opencode-openwork plugin to OpenCode to get your organization's models and MCP connections.",
    heading: "How does OpenWork work with OpenCode?",
    answer:
      "OpenWork runs on OpenCode, the open-source coding agent. The desktop app gives anyone a point-and-click OpenCode, and the opencode-openwork plugin brings your organization's models, skills, and connections into OpenCode in a terminal.",
    updated: "2026-10-10",
    keyFacts: [
      "Engine: OpenCode, on macOS, Windows, and Linux",
      "Plugin: opencode-openwork, for OpenCode 2",
      "Refreshes models and connections every 5 minutes",
      "License: open source, free desktop app"
    ],
    sections: [
      {
        id: "built-on-opencode",
        heading: "OpenWork is built on OpenCode",
        paragraphs: [
          "Every OpenWork chat runs on the OpenCode engine. OpenWork adds a desktop app for people who don't use a terminal, plus team features: shared skills, shared connections, models from your company, and admin controls.",
          "Anything OpenCode can do already works in OpenWork, even before it has its own button. Skills, MCP servers, providers, and opencode.json config files work the same way in both."
        ],
        bullets: [
          "Same engine: OpenWork runs OpenCode under the hood on macOS, Windows, and Linux.",
          "Same files: SKILL.md skills, MCP servers, and opencode.json or opencode.jsonc config work in both.",
          "Same models: any of the 50+ providers OpenCode supports, including local models.",
          "Shared access: the plugin exposes only the organization models and connections granted to the signed-in member."
        ]
      },
      {
        id: "plugin",
        heading: "The OpenWork plugin for OpenCode",
        paragraphs: [
          "Engineers who prefer the terminal don't need the desktop app. The opencode-openwork plugin connects a normal OpenCode 2 install to your OpenWork organization. You sign in once, and OpenCode loads your organization's setup each time it starts."
        ],
        steps: [
          {
            title: "Install the plugin",
            body: "Add the plugin to OpenCode 2.",
            code: "opencode plugin add opencode-openwork"
          },
          {
            title: "Sign in",
            body: "Choose Browser, sign in to OpenWork, and pick your organization. On a machine without a browser, add --method code and confirm the code on any device.",
            code: "opencode auth login openwork"
          },
          {
            title: "Check what you got",
            body: "Your company's AI Gateway models are listed with ipr_ names. The openwork-cloud MCP server gives the agent your organization's skills, plugins, and connections.",
            code: "opencode models | grep ipr_\nopencode mcp list"
          }
        ]
      },
      {
        id: "what-the-plugin-adds",
        heading: "What the plugin adds to OpenCode",
        table: {
          caption: "What the opencode-openwork plugin loads into OpenCode",
          columns: ["What", "What it means"],
          rows: [
            ["AI Gateway models", "The models your admin gave you, through your company's gateway. Provider keys stay on the server."],
            ["openwork-cloud MCP", "Your organization's skills, plugins, saved workflows, and connections, found with search_capabilities."],
            ["Direct connections", "Tools your admin shared, such as Slack or Google Workspace, listed as openwork-direct-<name>."],
            ["Automatic refresh", "New models and connections appear within minutes, with no restart."],
            ["Clean sign-out", "opencode auth logout openwork removes everything the plugin added."]
          ]
        },
        paragraphs: [
          "Self-hosting OpenWork? Set apiBaseUrl in the plugin options to your own OpenWork API. To load only models or only MCP, set providers or mcp to false."
        ]
      },
      {
        id: "which-one",
        heading: "OpenWork app or OpenCode with the plugin?",
        table: {
          caption: "Choosing between the OpenWork app and OpenCode with the plugin",
          columns: ["", "OpenWork desktop app", "OpenCode + opencode-openwork"],
          rows: [
            ["Best for", "Business teams and anyone who prefers a window", "Engineers who live in the terminal"],
            ["Engine", "OpenCode", "OpenCode"],
            ["Company models and connections", "Yes", "Yes"],
            ["Skills shared by your team", "Yes, installed in one click", "Yes, through openwork-cloud MCP"],
            ["Browser automation, scheduled tasks, file previews", "Yes", "Use OpenCode's own tools"],
            ["Sign-in", "Joining a team? Sign in", "opencode auth login openwork"]
          ]
        }
      }
    ],
    cards: [
      { icon: "library", title: "Install the OpenCode plugin", link: { label: "Plugin guide", href: "/docs/model-context-protocol/opencode-plugin" } },
      { icon: "route", title: "Only want MCP in OpenCode?", link: { label: "Connect OpenCode", href: "/docs/model-context-protocol/opencode" } },
      { icon: "users", title: "Share approved models with engineers", link: { label: "AI Gateway", href: "/docs/ai-gateway/overview" } },
      { icon: "monitor", title: "Prefer a desktop app?", link: { label: "Download OpenWork", href: "/download" } }
    ],
    faq: [
      {
        question: "Is OpenWork a fork of OpenCode?",
        answer:
          "No. OpenWork runs the OpenCode engine and adds a desktop app, team sharing, and admin controls. OpenCode features work in OpenWork as they are."
      },
      {
        question: "Do I need the OpenWork app to use the OpenCode plugin?",
        answer:
          "No. The opencode-openwork plugin works in plain OpenCode 2. Install it, sign in once, and OpenCode loads your organization's models and MCP connections."
      },
      {
        question: "Which OpenCode version does the plugin need?",
        answer: "OpenCode 2. OpenCode 1 is not supported by the plugin; use the OpenWork MCP URL instead."
      },
      {
        question: "Does the plugin work with self-hosted OpenWork?",
        answer: "Yes. Set apiBaseUrl in the plugin options in ~/.config/opencode/opencode.json to your OpenWork API address."
      },
      {
        question: "Are my existing OpenCode skills and config used by OpenWork?",
        answer:
          "Yes. OpenWork reads the same SKILL.md skills, MCP servers, and opencode.json files, so you can open an existing folder and keep working."
      }
    ],
    cta: {
      heading: "One engine for the whole company.",
      sub: "Engineers keep OpenCode. Everyone else gets the OpenWork app.",
      primary: { label: "Download OpenWork free", href: "/download" },
      secondary: { label: "OpenCode plugin docs", href: "/docs/model-context-protocol/opencode-plugin" }
    }
  },
  {
    slug: "claude-code-codex-cursor",
    label: "Claude Code, Codex, and Cursor",
    title: "Use OpenWork with Claude Code, Codex, and Cursor",
    description:
      "Yes. Add one MCP URL to Claude Code, Codex, Cursor, Claude Desktop, VS Code, or Gemini CLI to get your organization's OpenWork skills and connections.",
    heading: "Can you use OpenWork with Claude Code, Codex, or Cursor?",
    answer:
      "Yes. Add one MCP server URL to Claude Code, Codex, Cursor, Claude Desktop, VS Code, Gemini CLI, or ChatGPT, and the agent gets your organization's OpenWork skills, plugins, and connections, with the same access rules. AI Gateway models for these tools are in progress.",
    updated: "2026-10-10",
    keyFacts: [
      "MCP URL: https://api.openworklabs.com/mcp/agent",
      "Sign-in: OAuth in the browser, per organization",
      "Setup guides for 10 MCP clients",
      "First 5 OpenWork Cloud seats free"
    ],
    sections: [
      {
        id: "one-url",
        heading: "One MCP URL for every agent",
        paragraphs: [
          `OpenWork Connect is an MCP gateway at ${MCP_URL}. You sign in with your OpenWork account in the browser, pick your organization, and the agent can use what your admin shared with you.`,
          "The agent sees two main tools: search_capabilities finds the right skill, workflow, or connection, and execute_capability runs it. Your team adds a skill or connection once in OpenWork, and it shows up in every agent."
        ]
      },
      {
        id: "setup",
        heading: "Set it up in your agent",
        steps: [
          {
            title: "Claude Code",
            body: "Add the server, then run /mcp in Claude Code and choose openwork to sign in. Add -s user to use it in every project.",
            code: `claude mcp add --transport http openwork ${MCP_URL}`
          },
          {
            title: "Codex",
            body: "Add the server, then sign in.",
            code: `codex mcp add openwork --url ${MCP_URL}\ncodex mcp login openwork`
          },
          {
            title: "Cursor",
            body: "Add a remote MCP server in Cursor settings and paste the URL, or use the one-click install link in the docs.",
            code: MCP_URL
          },
          {
            title: "Claude Desktop and claude.ai",
            body: "Open Settings, then Connectors, then Add custom connector, and paste the URL.",
            code: MCP_URL
          },
          {
            title: "VS Code",
            body: "Add the server from the command line.",
            code: `code --add-mcp '{"name":"openwork","type":"http","url":"${MCP_URL}"}'`
          },
          {
            title: "Gemini CLI",
            body: "Add the server, then run /mcp auth openwork.",
            code: `gemini mcp add --transport http openwork ${MCP_URL}`
          }
        ]
      },
      {
        id: "what-you-get",
        heading: "What your agent gets",
        bullets: [
          "Your organization's skills, written once in OpenWork and used from any agent.",
          "Shared connections such as Google Workspace, Microsoft 365, Slack, and other MCP servers, without each person setting up their own keys.",
          "Saved workflows your team built, run by name.",
          "The same access rules as the OpenWork app: you only see what your organization, team, or admin granted you.",
          "Tool settings on every call: if an admin turns a tool off, it's off in every agent."
        ]
      },
      {
        id: "ai-gateway",
        heading: "AI Gateway models in Claude Code, Codex, and Cursor",
        paragraphs: [
          "The OpenWork AI Gateway lets admins add model providers once (OpenAI, Anthropic, Bedrock, Vertex, Azure, or any OpenAI-compatible endpoint), choose who can use them, and set spend limits. Provider keys stay on the server.",
          "OpenCode already gets these models through the opencode-openwork plugin. We are building the same integration for Claude Code, Codex, and Cursor, so every agent your engineers use runs on approved models with usage counted per person."
        ]
      }
    ],
    cards: [
      { icon: "route", title: "Connect any MCP client", link: { label: "Setup guide", href: "/docs/start-here/connect-openwork-mcp" } },
      { icon: "key", title: "Add models once with the AI Gateway", link: { label: "AI Gateway", href: "/docs/ai-gateway/overview" } },
      { icon: "library", title: "Use OpenCode? Install the plugin", link: { label: "OpenWork and OpenCode", href: "/guides/openwork-and-opencode" } },
      { icon: "users", title: "Share connections with your team", link: { label: "OpenWork Connect", href: "/connect" } }
    ],
    faq: [
      {
        question: "Does OpenWork work with Claude Code?",
        answer: `Yes. Run claude mcp add --transport http openwork ${MCP_URL}, then run /mcp and sign in.`
      },
      {
        question: "Does OpenWork work with Codex?",
        answer: `Yes. Run codex mcp add openwork --url ${MCP_URL}, then codex mcp login openwork.`
      },
      {
        question: "Does OpenWork work with Cursor?",
        answer: "Yes. Add the OpenWork MCP URL as a remote MCP server in Cursor, then sign in with your OpenWork account."
      },
      {
        question: "Do I need an OpenWork account?",
        answer: "Yes, an OpenWork Cloud account. The first 5 seats are free."
      },
      {
        question: "Can I use my company's AI Gateway models in Claude Code, Codex, or Cursor?",
        answer:
          "Not yet. OpenCode gets AI Gateway models today through the opencode-openwork plugin. The same integration for Claude Code, Codex, and Cursor is in progress."
      },
      {
        question: "How do I switch organizations?",
        answer: "Sign out of the openwork MCP server in your agent and sign in again, then pick the other organization."
      }
    ],
    cta: {
      heading: "Your team's skills, in every agent.",
      sub: "Add a skill or connection once. Use it from OpenWork, Claude Code, Codex, Cursor, and more.",
      primary: { label: "Get started free", href: "https://app.openworklabs.com?mode=sign-up" },
      secondary: { label: "Setup guide", href: "/docs/start-here/connect-openwork-mcp" }
    }
  },
  {
    slug: "ollama",
    label: "OpenWork with Ollama",
    title: "How to use OpenWork with Ollama and local models",
    description:
      "OpenWork has a built-in Ollama screen. Pull a model, add it to your workspace, and run AI agents on your files with no API key and nothing leaving your computer.",
    heading: "How does OpenWork work with Ollama?",
    answer:
      "OpenWork has a built-in Ollama screen. Start Ollama, open Settings › Ollama in OpenWork, pick or pull a model, and click Add to workspace. No API key and no account, and your prompts and files stay on your computer.",
    updated: "2026-10-10",
    keyFacts: [
      "Ollama address: http://localhost:11434",
      "LM Studio address: http://localhost:1234/v1",
      "No API key or account needed",
      "$0 OpenWork cost for local models"
    ],
    sections: [
      {
        id: "setup",
        heading: "Set up Ollama in OpenWork",
        steps: [
          {
            title: "Install and start Ollama",
            body: "Download Ollama from ollama.com and start it. OpenWork talks to it at http://localhost:11434."
          },
          {
            title: "Open Settings › Ollama",
            body: "Wait for the status to show Ollama running. If it doesn't, start Ollama and click refresh."
          },
          {
            title: "Pick or pull a model",
            body: "Choose a model you already have, or click Pull a model and type a name from the Ollama library. You can also pull it in a terminal first.",
            code: "ollama pull qwen2.5-coder:7b"
          },
          {
            title: "Add to workspace",
            body: "OpenWork saves it as Ollama (local). Start a chat and pick the model in the model picker."
          }
        ],
        paragraphs: [
          "OpenWork checks each model for image support and thinking levels, and Sync all models matches OpenWork to everything installed in Ollama."
        ]
      },
      {
        id: "other-local",
        heading: "LM Studio, llama.cpp, vLLM, and other local servers",
        paragraphs: [
          "Any local server with an OpenAI-compatible API works. Add it to opencode.jsonc in your workspace folder, then run Reload OpenCode config."
        ],
        steps: [
          {
            title: "Example: LM Studio",
            body: "Replace the model ID with the one your server reports.",
            code: `{
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio (local)",
      "options": { "baseURL": "http://localhost:1234/v1" },
      "models": { "qwen2.5-7b-instruct": { "name": "Qwen 2.5 7B Instruct" } }
    }
  }
}`
          }
        ]
      },
      {
        id: "pick-a-model",
        heading: "Pick a model that can use tools",
        paragraphs: [
          "OpenWork is an agent: it reads files, runs tools, and calls MCP servers. Small local models chat well but often struggle with tools. If a task stalls, try a larger model or one built for tool calling, and keep a cloud model connected for long tasks."
        ]
      },
      {
        id: "teams",
        heading: "Local and self-hosted models for a team",
        bullets: [
          "Share one self-hosted model: run Ollama or vLLM behind an endpoint your team can reach, and add it once in OpenWork Cloud as a custom provider. It shows up on everyone's desktop.",
          "Route it through the AI Gateway to choose who can use it and count usage per person.",
          "Want only approved models? Admins can turn on Only models you provide, which stops people adding their own providers, including local ones."
        ]
      }
    ],
    cards: [
      { icon: "cpu", title: "Full local model guide", link: { label: "Use local models", href: "/docs/start-here/connect-your-stack/use-local-models" } },
      { icon: "key", title: "Add a custom LLM or gateway", link: { label: "Custom LLM", href: "/docs/start-here/connect-your-stack/add-a-custom-llm" } },
      { icon: "users", title: "Share a self-hosted model with your team", link: { label: "Custom provider", href: "/docs/cloud/share-with-your-team/custom-llm-provider" } },
      { icon: "monitor", title: "Get the app", link: { label: "Download", href: "/download" } }
    ],
    faq: [
      {
        question: "Is OpenWork free with Ollama?",
        answer: "Yes. OpenWork is free and open source, and a local model adds no OpenWork cost. You only need a computer that can run the model."
      },
      {
        question: "Does anything leave my computer with Ollama?",
        answer: "Model inference goes to Ollama on your computer. Web tools, connectors, updates, and other enabled services can still make network requests; local inference is not a guarantee that the whole app is offline."
      },
      {
        question: "Which Ollama model should I use?",
        answer: "Start with a model built for tool calling, such as qwen2.5-coder. Bigger models handle multi-step tasks better."
      },
      {
        question: "Does OpenWork work offline?",
        answer: "Yes, once the model is downloaded. Chat on your files works without internet; web tools and online connectors don't."
      },
      {
        question: "Why can't I add Ollama on my work computer?",
        answer: "Your organization may allow only the models it provides. Ask your OpenWork admin."
      }
    ],
    cta: {
      heading: "AI agents on your files. Fully local.",
      sub: "Free, open source, and private by default.",
      primary: { label: "Download OpenWork free", href: "/download" },
      secondary: { label: "Local model guide", href: "/docs/start-here/connect-your-stack/use-local-models" }
    }
  },
  {
    slug: "control-ai-costs",
    label: "Keep AI costs under control",
    title: "How to keep AI agent costs under control",
    description:
      "Set daily, weekly, or monthly AI spend limits, see usage by model, team, or person, and choose lower-cost models for routine work.",
    heading: "How do you keep AI agent costs under control?",
    answer:
      "Use organization-managed provider keys, set daily, weekly, or monthly allowances, and review usage by model, team, or person. In OpenWork, use cheaper models for routine tasks and reserve frontier models for work that needs them.",
    updated: "2026-10-10",
    keyFacts: [
      "Spend limits per day, week, or month, in USD",
      "Limits for everyone, a team, or one person",
      "Usage by model, team, or person for the last 31 days",
      "Pause, warn, or approve requests for 25% more"
    ],
    sections: [
      {
        id: "why",
        heading: "Why AI agent costs get out of hand",
        paragraphs: [
          "Agents use far more tokens than chat. One task can read dozens of files, call tools, and retry, and every step is billed. When people pay with personal keys, the company can't see the total until the invoices arrive.",
          "Most of the waste comes from three places: no limits, no visibility, and using a frontier model for questions a small model could answer."
        ]
      },
      {
        id: "limits",
        heading: "Set spend limits",
        paragraphs: [
          "Spend limits apply to priced organization-key providers; they do not cap every external bill or personal provider key. In the AI Gateway, open Limits and choose who a limit applies to: everyone in the organization (including people who join later), a team, or one person. Turn on any mix of a daily, weekly, and monthly amount. Whichever runs out first applies."
        ],
        table: {
          caption: "What happens when someone reaches a spend limit",
          columns: ["Choice", "What happens"],
          rows: [
            ["Pause their models", "Requests stop until the limit resets or an admin gives more."],
            ["Only warn", "Requests keep working and the limit shows as over."],
            ["Let them ask for 25% more", "The person can request more, and admins approve or deny it in Limits."]
          ]
        },
        bullets: [
          "In the desktop app, the chat says which limit was reached and when it resets.",
          "Members see what's left in the account menu and in Settings › Usage."
        ]
      },
      {
        id: "visibility",
        heading: "See who spends what",
        bullets: [
          "The AI Gateway overview shows who spends the most and which models people use.",
          "Usage charts show tokens or cost for the last 31 days, grouped by model, team, or person.",
          "Each person's page shows what they can use, their limit, and their recent spend.",
          "Costs come from token counts and published model prices, including cached input and reasoning tokens."
        ]
      },
      {
        id: "cheaper-models",
        heading: "Use cheaper models where they're good enough",
        bullets: [
          "OpenWork Models gives your team hand-picked open models, such as GLM, Kimi, and DeepSeek, for $10 per user per month, with no API keys to manage.",
          "Local models through Ollama or LM Studio cost nothing per token.",
          "Grant expensive models only to the teams that need them, and turn on Only models you provide so nobody adds a personal key.",
          "Already run LiteLLM? Connect it to OpenWork and keep its budgets."
        ]
      }
    ],
    cards: [
      { icon: "route", title: "Spend limits and model access", link: { label: "AI Gateway", href: "/docs/ai-gateway/overview" } },
      { icon: "library", title: "How token costs are counted", link: { label: "Token costs", href: "/docs/ai-gateway/token-costs" } },
      { icon: "cpu", title: "Run models for free on your computer", link: { label: "OpenWork with Ollama", href: "/guides/ollama" } },
      { icon: "key", title: "How gateway limits work", link: { label: "Request flow", href: "/docs/ai-gateway/how-requests-flow" } }
    ],
    faq: [
      {
        question: "Can I set a monthly AI budget per team?",
        answer: "Yes. In the AI Gateway, add a spend limit for a team with a monthly amount. You can also add daily or weekly amounts; whichever runs out first applies."
      },
      {
        question: "What happens when someone hits their limit?",
        answer: "You choose: pause their models, only warn, or let them ask for 25% more for an admin to approve."
      },
      {
        question: "Are the cost numbers exact?",
        answer: "They're close estimates from token counts and published prices. Your provider's invoice is the final number."
      }
    ],
    cta: {
      heading: "Know what AI costs before the invoice.",
      sub: "Spend allowances and usage reporting for organization-managed providers.",
      primary: { label: "Get started free", href: "https://app.openworklabs.com?mode=sign-up" },
      secondary: { label: "AI Gateway docs", href: "/docs/ai-gateway/overview" }
    }
  },
  {
    slug: "engineers-and-business-teams",
    label: "Engineers and business teams",
    title: "AI controls for engineers and business teams",
    description:
      "Share organization models and connections across OpenWork and engineering tools. Learn where gateway controls apply and which desktop permissions are planned.",
    heading: "Engineers and business teams use different AI tools. How do you keep one security policy?",
    answer:
      "Share organization access without assuming every client is controlled. Business teams can use OpenWork; engineers can connect OpenCode or an MCP client. Gateway grants cover organization resources, not the client's shell or whole device. Desktop agent permissions are planned, pending enforcement and rollout.",
    updated: "2026-10-10",
    keyFacts: [
      "OpenWork and OpenCode can use organization AI Gateway models",
      "Claude Code, Codex, and Cursor connect to organization resources through MCP, not AI Gateway inference",
      "Gateway grants do not control local commands or unrelated provider sessions",
      "Planned desktop agent permissions require enforcement and feature activation"
    ],
    sections: [
      {
        id: "problem",
        heading: "Why one tool for everyone doesn't work",
        paragraphs: [
          "Engineers often want a terminal agent they can script. Finance, legal, sales, and operations often prefer a window and their files. An approved setup should support both groups without promising controls it cannot enforce.",
          "OpenWork provides shared organization resources. Client-local tools, independent accounts, and device security still need their own controls."
        ]
      },
      {
        id: "how",
        heading: "What teams can share today",
        table: {
          caption: "Organization resources and their enforcement boundaries",
          columns: ["Resource", "OpenWork desktop and OpenCode plugin", "Claude Code, Codex, Cursor through MCP"],
          rows: [
            ["Sign-in", "OpenWork organization sign-in", "OAuth sign-in for the OpenWork MCP connection"],
            ["Models", "Granted AI Gateway models", "AI Gateway inference integration is not available"],
            ["Skills and connections", "Organization resources granted to the member", "Granted resources through the MCP gateway"],
            ["Connection tool switches", "Apply to calls routed through the gateway", "Apply to calls routed through the gateway, not the client's other tools"],
            ["Local commands", "Planned desktop agent permissions; the plain OpenCode plugin does not enforce them", "Use the client's own permissions and device controls"],
            ["Evidence", "Admin audit events and gateway usage", "Not an exhaustive log of the client's actions or connector side effects"]
          ]
        }
      },
      {
        id: "shared",
        heading: "Keep identity, model access, and connections aligned",
        bullets: [
          "Identity: use company SSO and SCIM for organization membership. Organization revocation does not revoke independent provider sessions or accounts outside that organization.",
          "Models: grant organization-managed providers to the teams that need them. Organization provider keys are held by the gateway; separately configured keys remain outside that boundary.",
          "Connections: grant approved resources and disable gateway tools where appropriate. These switches do not control local shell commands, independently configured connections, or the whole device.",
          "Evidence: review admin changes and gateway usage alongside each client's and connected service's records. External connector side effects are not exhaustively captured in one audit log."
        ]
      },
      {
        id: "opencode",
        heading: "Desktop agent permissions",
        badge: "Planned",
        paragraphs: [
          "Planned desktop agent permissions use OpenCode rules for commands, file edits, web access, and local skills and MCP servers. These controls are not available yet; existing gateway permissions do not enforce them on a computer.",
          "The agentPermissions feature must also be enabled for the organization. It can be disabled; no guide should promise unconditional or device-wide enforcement. The plain opencode-openwork plugin supplies models and connections, not desktop permission enforcement."
        ]
      }
    ],
    cards: [
      { icon: "library", title: "Engineers: add OpenWork to OpenCode", link: { label: "OpenCode guide", href: "/guides/openwork-and-opencode" } },
      { icon: "route", title: "Connect engineering tools through MCP", link: { label: "MCP guide", href: "/guides/claude-code-codex-cursor" } },
      { icon: "key", title: "Current desktop policy status", link: { label: "Desktop policies docs", href: "/docs/cloud/share-with-your-team/desktop-policies" } },
      { icon: "library", title: "Inspect the current source", link: { label: "OpenWork source code", href: "https://github.com/different-ai/openwork" } }
    ],
    faq: [
      { question: "Do engineers have to switch to the OpenWork app?", answer: "No. OpenCode can use the opencode-openwork plugin. Claude Code, Codex, and Cursor can connect organization resources through MCP; that connection does not configure their inference provider or local permissions." },
      { question: "Do business teams need a terminal?", answer: "No. The OpenWork desktop app provides a point-and-click workspace with organization resources after sign-in." },
      { question: "Can different teams get different access?", answer: "Organization models and connections can be granted to teams. Desktop agent permission rules are Planned, pending enforcement and feature activation; they are not a universal policy for every client." },
      { question: "Does removing a member revoke every AI account?", answer: "No. Organization access revocation does not revoke provider sessions or personal accounts outside the organization." }
    ],
    cta: {
      heading: "Different tools. Shared organization access.",
      sub: "Check each client's enforcement boundary before relying on a control.",
      primary: { label: "Talk to us", href: "/enterprise#book" },
      secondary: { label: "Read MCP docs", href: "/docs/start-here/connect-openwork-mcp" }
    }
  },
  {
    slug: "ai-policies-and-controls",
    label: "AI policies and controls",
    title: "AI policies and admin controls in OpenWork",
    description:
      "Current OpenWork controls for identity, organization models, spend, connections, and app versions, plus planned agent permissions and paused desktop policies.",
    heading: "What do policies and controls mean in OpenWork?",
    answer:
      "OpenWork controls organization access, gateway models and spend, and shared connections. The desktop currently applies custom-provider access and allowed-version settings; most desktop policies are paused. Agent permissions for commands, websites, and local extensions are planned, pending enforcement work and feature activation.",
    updated: "2026-10-10",
    keyFacts: [
      "Gateway controls apply to organization resources, not the whole device",
      "Most desktop policy controls are paused",
      "Current desktop controls include custom-provider access and allowed versions",
      "Planned agent permissions are not live enforcement"
    ],
    sections: [
      {
        id: "layers",
        heading: "The controls, layer by layer",
        table: {
          caption: "Current controls, paused settings, and planned enforcement",
          columns: ["Control", "Scope and status", "Where admins set it"],
          rows: [
            ["Sign-in and roles", "Organization membership, SSO, SCIM, and role-based access; not revocation of independent provider accounts", "SSO, SCIM, Members"],
            ["Models", "Granted organization providers and models; custom-provider access applies in managed OpenWork desktop, not every external client", "AI Gateway"],
            ["Spend", "Allowances for priced organization-key providers; not a cap on personal keys or every external bill", "AI Gateway"],
            ["Agent permissions", "Planned: command, file-edit, web, and local-extension rules; requires enforcement and agentPermissions activation", "Planned Agent permissions editor"],
            ["Desktop policies", "Paused: extra workspaces, settings, extension installation, built-in extensions, alpha updates, command and browser restrictions", "Desktop policies (saved settings are not enforcement)"],
            ["App versions", "Allowed Desktop Versions applies to the OpenWork desktop app", "Settings › General"],
            ["Connections", "Resource grants and tool switches for calls through the MCP gateway; not local commands or independent connections", "Connections"],
            ["Audit and usage", "Admin audit events and usage reporting; not an exhaustive record of tool actions or external side effects", "Audit logs, Analytics"]
          ]
        }
      },
      {
        id: "agent-permissions",
        heading: "Agent permissions: proposed desktop rules",
        badge: "Planned",
        paragraphs: [
          "The proposed rules cover commands, file edits, websites, web search, and local skills and MCP servers, with organization and team settings. Allow, Block, and Ask first describe the planned permission choices, not a control to rely on today.",
          "These controls are planned, not enforced today. Do not rely on saved desktop-policy settings to block actions: availability requires a supported desktop release and your organization having the feature enabled."
        ]
      },
      {
        id: "how-rules-combine",
        heading: "Check the scope of each setting",
        bullets: [
          "Organization model and connection grants apply to the member's organization resources.",
          "Desktop custom-provider access and allowed versions apply in managed OpenWork desktop, not other apps or the user's entire computer.",
          "Planned agent permissions have their own rule-resolution behavior; do not infer it from paused desktop policy settings.",
          "SSO and SCIM manage organization access, not every independently authorized provider or connector session.",
          "Client permissions, operating-system controls, and connected-service access rules remain separate."
        ]
      },
      {
        id: "where-enforced",
        heading: "Where each control applies",
        table: {
          caption: "Client boundaries; MCP access is not device management",
          columns: ["Control", "OpenWork desktop", "Plain OpenCode plugin", "Claude Code, Codex, Cursor through MCP"],
          rows: [
            ["Organization access", "Organization resources", "Organization resources", "OpenWork MCP resources only"],
            ["Gateway model access and spend", "Gateway requests", "Gateway requests", "Inference integration not available"],
            ["Connection grants and tool switches", "Calls through gateway", "Calls through gateway", "Calls through gateway, not local shell"],
            ["Agent permissions", "Planned; rollout prerequisite", "Not enforced by this plugin", "Use client-local permissions"],
            ["Custom-provider access and allowed versions", "Current desktop settings", "Not desktop enforcement", "Not applicable"],
            ["Other desktop policies", "Paused", "Not applicable", "Not applicable"]
          ]
        }
      }
    ],
    cards: [
      { icon: "key", title: "Desktop policies and paused controls", link: { label: "Docs", href: "/docs/cloud/share-with-your-team/desktop-policies" } },
      { icon: "users", title: "Members, roles, and permissions", link: { label: "Docs", href: "/docs/cloud/members-and-rbac" } },
      { icon: "route", title: "AI Gateway access and limits", link: { label: "Docs", href: "/docs/ai-gateway/overview" } },
      { icon: "library", title: "Current desktop policy documentation source", link: { label: "Source", href: "https://github.com/different-ai/openwork/blob/dev/packages/docs/cloud/share-with-your-team/desktop-policies.mdx" } }
    ],
    faq: [
      { question: "Can I stop people using their own API keys?", answer: "Only models you provide limits custom-provider access in managed OpenWork desktop. It does not prevent personal keys in other clients, scripts, or devices." },
      { question: "Can I block risky commands?", answer: "Organization-managed agent permissions are Planned, pending enforcement and feature activation. Do not rely on paused desktop command settings or MCP tool switches to block local shell commands." },
      { question: "Can I limit which websites agents open?", answer: "Desktop organization website rules are Planned. The current desktop-policy approved-sites controls are paused; gateway grants do not limit a client's browser or web tools." },
      { question: "Can I pin the desktop app version?", answer: "Allowed Desktop Versions is a current OpenWork desktop setting in Settings › General. It is not a control for independently installed AI clients." },
      { question: "Does one audit log capture every action?", answer: "No. Admin audit events and gateway usage do not exhaustively record every client tool call or external connector side effect. Review the documented event fields and connected-service records; this is not a blanket privacy or completeness guarantee." }
    ],
    cta: {
      heading: "Check which controls apply today.",
      sub: "Separate current gateway access from paused policies and planned desktop permissions.",
      primary: { label: "Talk to us", href: "/enterprise#book" },
      secondary: { label: "Desktop policies docs", href: "/docs/cloud/share-with-your-team/desktop-policies" }
    }
  },
  {
    slug: "prevent-shadow-ai",
    label: "Prevent shadow AI",
    title: "How to reduce shadow AI at work",
    description:
      "Reduce unapproved AI use with useful approved tools, organization models, SSO, shared connections, and usage review. Planned permissions are not live controls.",
    heading: "How do you prevent shadow AI?",
    answer:
      "Reduce shadow AI by making approved tools useful, sharing organization models and connections, and reviewing adoption. OpenWork supports that approved path, but cannot make it the only path to company data. Local commands, independent accounts, and device security need separate controls; desktop agent permissions are planned.",
    updated: "2026-10-10",
    keyFacts: [
      "Seven steps to reduce unapproved AI use, not a prevention guarantee",
      "Organization provider keys are held by the gateway",
      "MCP access does not control client-local tools",
      "Planned permissions require enforcement, release, and feature activation"
    ],
    sections: [
      {
        id: "what",
        heading: "What is shadow AI?",
        paragraphs: [
          "Shadow AI is using tools, accounts, or extensions an organization has not approved, such as a personal chat account, an unvetted MCP server, or a personally funded provider key. It can send company data outside the organization's approved processing and access rules.",
          "People may turn to those tools when the approved setup is missing, slow, or limited. Providing a useful approved option addresses part of the problem, not every route around it."
        ]
      },
      {
        id: "why-bans-fail",
        heading: "Why blocking alone is not enough",
        bullets: [
          "A website block does not cover personal devices or independent accounts.",
          "Engineers and business teams often need different interfaces.",
          "Usage reporting covers the approved path, not every unapproved tool.",
          "Use training, identity, endpoint, and data-access controls alongside the approved AI setup."
        ]
      },
      {
        id: "steps",
        heading: "Seven steps to reduce shadow AI with OpenWork",
        steps: [
          { title: "Give everyone an approved agent", body: "Offer OpenWork desktop for macOS, Windows, and Linux. Local files can be used in a workspace; prompts, selected content, and tool requests may still be sent to the configured provider or service." },
          { title: "Provide useful organization models", body: "Grant organization-managed gateway providers to the teams that need them. Gateway-held keys are separate from personal keys or providers configured outside that organization." },
          { title: "Use company sign-in", body: "Configure organization SSO and SCIM, and required desktop sign-in through the managed installation where appropriate. Organization revocation does not revoke independent provider sessions." },
          { title: "Limit custom providers and plan local permissions", body: "Only models you provide is a current managed-desktop control. Local skill, MCP-server, command, and website rules are planned, not available yet; paused extension settings do not block unapproved extensions today." },
          { title: "Share approved skills and connections", body: "Publish useful organization resources and grant access to teams. Tool switches apply to gateway-routed calls, not independently configured services or local shell commands." },
          { title: "Cover engineers without overstating MCP", body: "OpenCode can use the opencode-openwork plugin for organization models and resources. Claude Code, Codex, and Cursor can connect resources through MCP, but AI Gateway inference integration is not available and their local permissions remain separate." },
          { title: "Review usage and gaps", body: "Use gateway usage, spend reporting, and admin audit events to review adoption. Combine them with client and service records: external connector side effects are not exhaustively logged by OpenWork." }
        ]
      },
      {
        id: "checklist",
        heading: "Shadow AI checklist",
        table: {
          caption: "Risk reduction and remaining boundaries",
          columns: ["Risk", "OpenWork control or prerequisite"],
          rows: [
            ["Personal AI accounts", "Offer an approved desktop app; personal accounts remain outside organization control"],
            ["Personal provider keys", "Gateway-managed keys and desktop custom-provider access; not a device-wide key ban"],
            ["Unvetted local skills and MCP servers", "Planned agent permissions; enforcement and feature activation required"],
            ["Risky local commands", "Planned agent permissions; MCP tool switches do not control shell commands"],
            ["Unapproved websites", "Planned desktop website rules; current desktop-policy browsing restrictions are paused"],
            ["Former members keeping access", "SSO/SCIM organization revocation; separately revoke external sessions where necessary"],
            ["Runaway spend", "Allowances for priced organization-key providers, not all external bills"],
            ["Incomplete audit evidence", "Admin events and gateway usage plus client and connected-service records"]
          ]
        }
      }
    ],
    cards: [
      { icon: "key", title: "Current and planned admin controls", link: { label: "Policies and controls", href: "/guides/ai-policies-and-controls" } },
      { icon: "users", title: "Organization access across team tools", link: { label: "Read the guide", href: "/guides/engineers-and-business-teams" } },
      { icon: "cloud", title: "Data handling and subprocessors", link: { label: "Trust Center", href: "/trust" } },
      { icon: "monitor", title: "Roll out the desktop app", link: { label: "Enterprise deployment docs", href: "/docs/start-here/enterprise-desktop-deployment" } }
    ],
    faq: [
      { question: "What is shadow AI?", answer: "Using AI tools, accounts, or extensions an organization has not approved. It can put company data outside approved processing and access rules." },
      { question: "Is shadow AI a security risk?", answer: "It can expose confidential data, bypass approved access paths, hide spend, and create gaps in evidence. The risk depends on what data is shared and which services are used." },
      { question: "Should we just block AI websites?", answer: "Use appropriate endpoint and data controls alongside an approved tool people can use. Website blocks alone do not cover independent accounts, scripts, or personal devices." },
      { question: "Does OpenWork prevent all shadow AI?", answer: "No. It supports an approved path and organization access controls, not a universal device sandbox or a guarantee against unapproved use. Planned desktop permissions are not live controls." },
      { question: "Does OpenWork lock us into one AI vendor?", answer: "No. OpenWork is open source and supports the providers and local models available through OpenCode." }
    ],
    cta: {
      heading: "Make the approved path useful.",
      sub: "Reduce unapproved use without assuming every client or device is controlled.",
      primary: { label: "Talk to us", href: "/enterprise#book" },
      secondary: { label: "Deployment docs", href: "/docs/start-here/enterprise-desktop-deployment" }
    }
  }
];

export function guidePath(guide: Guide): string {
  return `${GUIDES_PATH}/${guide.slug}`;
}

export function findGuide(slug: string): Guide | undefined {
  return guides.find((guide) => guide.slug === slug);
}

function absolute(href: string): string {
  return href.startsWith("http") ? href : `${SITE_URL}${href}`;
}

function tableMarkdown(table: GuideTable): string {
  const header = `| ${table.columns.join(" | ")} |`;
  const divider = `| ${table.columns.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map((row) => `| ${row.join(" | ")} |`);
  return [header, divider, ...rows].join("\n");
}

function sectionMarkdown(section: GuideSection): string {
  const parts: string[] = [`## ${section.heading}${section.badge ? ` (${section.badge})` : ""}`];
  for (const paragraph of section.paragraphs ?? []) parts.push(paragraph);
  if (section.steps) {
    parts.push(
      section.steps
        .map((step, index) => {
          const code = step.code ? `\n\n   \`\`\`\n${step.code.replace(/^/gm, "   ")}\n   \`\`\`` : "";
          return `${index + 1}. **${step.title}** — ${step.body}${code}`;
        })
        .join("\n")
    );
  }
  if (section.table) parts.push(tableMarkdown(section.table));
  if (section.bullets) parts.push(section.bullets.map((bullet) => `- ${bullet}`).join("\n"));
  return parts.join("\n\n");
}

export function guideMarkdown(guide: Guide): string {
  return `# ${guide.heading}

> ${guide.answer}

Updated ${guide.updated}

${guide.keyFacts.map((fact) => `- ${fact}`).join("\n")}

${guide.sections.map(sectionMarkdown).join("\n\n")}

## FAQ

${guide.faq.map((entry) => `### ${entry.question}\n${entry.answer}`).join("\n\n")}

## Related

${guide.cards.map((card) => `- ${card.title}: [${card.link.label}](${absolute(card.link.href)})`).join("\n")}
- [${guide.cta.primary.label}](${absolute(guide.cta.primary.href)})
`;
}

export function guidesIndexMarkdown(): string {
  return `# OpenWork guides

> Short answers about OpenWork with OpenCode, MCP clients, local models, AI costs, and organization controls. Desktop agent permissions are Planned; most desktop policies are paused.

${guides.map((guide) => `- [${guide.heading}](${SITE_URL}${guidePath(guide)}) — ${guide.answer}`).join("\n")}
`;
}
