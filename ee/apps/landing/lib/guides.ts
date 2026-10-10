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
          "Same permissions: OpenWork's agent rules are OpenCode permission rules, so engineers already know how they work."
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
      { icon: "users", title: "Engineers and business teams on one policy", link: { label: "Read the guide", href: "/guides/engineers-and-business-teams" } },
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
        answer: "Model requests go to Ollama on your computer. Only connectors and MCP servers you add talk to their own services."
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
    slug: "engineers-and-business-teams",
    label: "Engineers and business teams",
    title: "One AI security policy for engineers and business teams",
    description:
      "Engineers use OpenCode, Claude Code, Codex, and Cursor. Business teams use the OpenWork app. OpenWork puts both under one set of models, connections, and rules.",
    heading: "Engineers and business teams use different AI tools. How do you keep one security policy?",
    answer:
      "Let each team keep its tools and share one control layer. Business teams use the OpenWork app; engineers use OpenCode, Claude Code, Codex, or Cursor. All of them sign in to the same OpenWork organization and get the same models, connections, access rules, and audit log.",
    updated: "2026-10-10",
    keyFacts: [
      "One organization for every tool",
      "SSO with Okta, Microsoft Entra ID, or Google Workspace",
      "Same models, connections, and audit log",
      "Rules per organization or per team"
    ],
    sections: [
      {
        id: "problem",
        heading: "Why one tool for everyone doesn't work",
        paragraphs: [
          "Engineers want a terminal agent they can script. Finance, legal, sales, and operations want a window, their files, and no setup. Forcing one tool on both groups means one of them quietly goes around it.",
          "The fix is not one app. It's one place where security decides which models, data, and actions agents may use, and every tool follows it."
        ]
      },
      {
        id: "how",
        heading: "How it works",
        table: {
          caption: "What business teams and engineers use, and what they share",
          columns: ["", "Business teams", "Engineers"],
          rows: [
            ["App", "OpenWork desktop or OpenWork Web", "OpenCode, Claude Code, Codex, Cursor, VS Code"],
            ["How it connects", "Joining a team? Sign in", "opencode-openwork plugin, or the OpenWork MCP URL"],
            ["Sign-in", "Company SSO", "Same company SSO"],
            ["Models", "AI Gateway models granted to their team", "Same AI Gateway models (OpenCode today, others in progress)"],
            ["Skills and connections", "Granted to their team", "Same grants, through MCP"],
            ["Tool settings", "Enforced on every call", "Enforced on every call"],
            ["Audit and usage", "One organization log", "Same log"]
          ]
        }
      },
      {
        id: "shared",
        heading: "What stays the same across every tool",
        bullets: [
          "Identity: one organization, company SSO, and SCIM. Remove someone in your identity provider and they lose access everywhere.",
          "Models: admins add providers once in the AI Gateway, grant them to teams, and set spend limits. Provider keys never reach laptops.",
          "Data and actions: shared connections such as Google Workspace, Microsoft 365, and Slack are granted per team, and admins can switch individual tools off for everyone.",
          "Skills: approved skills are published once and reach the OpenWork app and every MCP client.",
          "Evidence: admin changes are written to the audit log, and usage is counted per person and per team."
        ]
      },
      {
        id: "opencode",
        heading: "Why OpenCode makes this easier",
        paragraphs: [
          "The OpenWork app runs on OpenCode. Agent permissions in OpenWork, such as which commands can run, which websites agents can open, and which local skills and MCP servers are allowed, are OpenCode permission rules. Security writes one set of rules, and engineers can read them in the format they already use.",
          "On business teams' computers, the OpenWork app enforces those rules, names the rule that blocked an action, and keeps them in force even if it can't reach OpenWork Cloud."
        ]
      }
    ],
    cards: [
      { icon: "library", title: "Engineers: add OpenWork to OpenCode", link: { label: "OpenCode guide", href: "/guides/openwork-and-opencode" } },
      { icon: "route", title: "Engineers: Claude Code, Codex, Cursor", link: { label: "MCP guide", href: "/guides/claude-code-codex-cursor" } },
      { icon: "key", title: "What admins can control", link: { label: "Policies and controls", href: "/guides/ai-policies-and-controls" } },
      { icon: "users", title: "Stop shadow AI", link: { label: "Read the guide", href: "/guides/prevent-shadow-ai" } }
    ],
    faq: [
      {
        question: "Do engineers have to switch to the OpenWork app?",
        answer:
          "No. Engineers keep OpenCode, Claude Code, Codex, or Cursor and connect them to the same OpenWork organization with the opencode-openwork plugin or the OpenWork MCP URL."
      },
      {
        question: "Do business teams need a terminal?",
        answer: "No. The OpenWork desktop app is point and click. Skills and connections shared by the company appear after sign-in."
      },
      {
        question: "Where are policies set?",
        answer: "In one OpenWork Cloud dashboard, for the whole organization or per team. Self-hosted OpenWork has the same dashboard."
      },
      {
        question: "Can different teams get different rules?",
        answer: "Yes. Models, connections, skills, and agent permissions can be granted per team, so contractors can get stricter rules than full-time staff."
      }
    ],
    cta: {
      heading: "Different tools. One policy.",
      sub: "Give every team the agent it likes, under one set of rules.",
      primary: { label: "Talk to us", href: "/enterprise#book" },
      secondary: { label: "Get started free", href: "https://app.openworklabs.com?mode=sign-up" }
    }
  },
  {
    slug: "ai-policies-and-controls",
    label: "AI policies and controls",
    title: "AI policies and admin controls in OpenWork",
    description:
      "What OpenWork admins can control: sign-in, roles, models, spend, agent permissions, desktop policies, connections, and audit, for everyone or per team.",
    heading: "What do policies and controls mean in OpenWork?",
    answer:
      "Policies are rules admins set once in OpenWork Cloud that every member's agent follows: who can sign in, which models they can use and how much they can spend, which commands, websites, skills, and connections agents may use, and which app versions are allowed. They apply to everyone or per team.",
    updated: "2026-10-10",
    keyFacts: [
      "9 control areas, set in one dashboard",
      "Rules per organization, team, or person",
      "Agent rules: Allow, Block, or Ask first",
      "Audit log never stores prompts or secrets"
    ],
    sections: [
      {
        id: "layers",
        heading: "The controls, layer by layer",
        table: {
          caption: "OpenWork admin controls and what each one decides",
          columns: ["Control", "What it decides", "Where admins set it"],
          rows: [
            ["Sign-in", "Company SSO (Okta, Microsoft Entra ID, Google Workspace), SCIM provisioning, allowed email domains, and required sign-in on managed computers", "SSO and SCIM settings"],
            ["Roles", "Owner, Admin, or Member; admin teams synced from your identity provider; custom permission grants on Enterprise", "Members"],
            ["Models", "Which providers and models each team or person can use, and whether people may add their own", "AI Gateway"],
            ["Spend", "Daily, weekly, or monthly USD limits per team or person", "AI Gateway"],
            ["Agent permissions", "Which commands agents can run, whether they can edit files, which websites they can open, web search, and which local skills and MCP servers are allowed. Each rule is Allow, Block, or Ask first", "Agent permissions"],
            ["Desktop policies", "Extra workspaces, desktop settings, installing extensions, built-in extensions, and early-access updates", "Desktop policies"],
            ["App versions", "Which OpenWork versions the desktop app may install", "General settings"],
            ["Connections", "Who can use each shared connection, and which of its tools are switched off", "Connections"],
            ["Audit", "A log of admin changes, plus usage per member and team, without prompts or secrets", "Audit logs, Analytics"]
          ]
        }
      },
      {
        id: "agent-permissions",
        heading: "Agent permissions: what agents may do on a computer",
        paragraphs: [
          "Agent permissions decide what an agent can do on a member's computer. Admins pick a rule for each kind of action, for everyone or per team, and can test a request against the rules before saving."
        ],
        bullets: [
          "Commands: allow, block, or ask first, with patterns such as git * or rm *.",
          "File edits: allow or block changes to files.",
          "Websites: allow only listed sites, or block some, in agent web fetches and the built-in browser.",
          "Local skills and MCP servers: allow only the ones your team approved. Skills and connections the organization shares always keep working.",
          "When an action is blocked, the member sees which rule blocked it.",
          "Rules stay in force if the computer can't reach OpenWork Cloud."
        ]
      },
      {
        id: "how-rules-combine",
        heading: "How rules combine",
        bullets: [
          "Organization first: the organization's settings apply to everyone.",
          "Teams on top: a team can have its own settings or inherit the organization's.",
          "Strictest wins: if someone is on two teams, the stricter agent permission applies.",
          "A team marked Blocked for a capability stays blocked, whatever other policies allow.",
          "No policies means no restrictions, so small teams can start without setup."
        ]
      },
      {
        id: "where-enforced",
        heading: "Where each control is enforced",
        table: {
          caption: "Where OpenWork enforces each type of control",
          columns: ["Control", "OpenWork app", "OpenCode with the plugin", "Claude Code, Codex, Cursor (MCP)"],
          rows: [
            ["SSO and roles", "Yes", "Yes", "Yes"],
            ["Model access and spend limits", "Yes", "Yes", "In progress"],
            ["Skill and connection access", "Yes", "Yes", "Yes"],
            ["Connection tool settings", "Yes", "Yes", "Yes"],
            ["Agent permissions", "Yes", "Desktop app only today", "Use the client's own settings"],
            ["Desktop policies and app versions", "Yes", "Not applicable", "Not applicable"]
          ]
        }
      }
    ],
    cards: [
      { icon: "key", title: "Desktop policies", link: { label: "Docs", href: "/docs/cloud/share-with-your-team/desktop-policies" } },
      { icon: "users", title: "Members, roles, and permissions", link: { label: "Docs", href: "/docs/cloud/members-and-rbac" } },
      { icon: "route", title: "AI Gateway access and limits", link: { label: "Docs", href: "/docs/ai-gateway/overview" } },
      { icon: "cloud", title: "Security and operations", link: { label: "Docs", href: "/docs/cloud/security-and-operations" } }
    ],
    faq: [
      {
        question: "Can I stop people using their own API keys?",
        answer: "Yes. Turn on Only models you provide in the AI Gateway. Members can then use only models the organization deployed."
      },
      {
        question: "Can I block risky commands?",
        answer: "Yes. Agent permissions let you block or require approval for commands by pattern, for everyone or per team."
      },
      {
        question: "Can I limit which websites agents open?",
        answer: "Yes. Allow or block sites for agent web fetches and the built-in browser."
      },
      {
        question: "Can I pin the desktop app version?",
        answer: "Yes. Owners choose which OpenWork versions the desktop app may install."
      },
      {
        question: "Does the audit log store prompts?",
        answer: "No. It records who changed what and when, never request bodies or secrets."
      },
      {
        question: "Which plan includes policies?",
        answer: "Desktop policies, agent permissions, SCIM, and the audit log are on Enterprise, cloud or self-hosted. SSO is on Team."
      }
    ],
    cta: {
      heading: "Set the rules once.",
      sub: "Every agent, on every computer, follows them.",
      primary: { label: "Talk to us", href: "/enterprise#book" },
      secondary: { label: "Desktop policies docs", href: "/docs/cloud/share-with-your-team/desktop-policies" }
    }
  },
  {
    slug: "control-ai-costs",
    label: "Keep AI costs under control",
    title: "How to keep AI agent costs under control",
    description:
      "Set daily, weekly, or monthly spend limits per team or person, see who spends what, and route each prompt to the right model with OpenWork Auto routing (preview).",
    heading: "How do you keep AI agent costs under control?",
    answer:
      "Put every model behind one gateway, give each team or person a daily, weekly, or monthly spend limit, and send each prompt to the cheapest model that can handle it. OpenWork does all three, and its Auto routing, now in preview, picks the model from instructions you write in plain English.",
    updated: "2026-10-10",
    keyFacts: [
      "Spend limits per day, week, or month, in USD",
      "Limits for everyone, a team, or one person",
      "Usage by model, team, or person for the last 31 days",
      "Auto routing: 2 to 12 plain-English categories (preview)"
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
          "In the AI Gateway, open Limits and choose who a limit applies to: everyone in the organization (including people who join later), a team, or one person. Turn on any mix of a daily, weekly, and monthly amount. Whichever runs out first applies."
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
        id: "auto-routing",
        heading: "Auto routing: the right model for each prompt",
        badge: "In preview",
        paragraphs: [
          "Auto routing reads each new prompt and sends it to the model you chose for that kind of work. You describe the categories in plain English, pick a model for each, and choose a fallback. No rules engine and no code.",
          "Use it to save money and to keep sensitive work private: everyday questions go to a fast, low-cost model, hard problems go to a frontier model, and prompts about customer data, contracts, or health records go to a model running on your own infrastructure."
        ],
        table: {
          caption: "Example Auto routing setup",
          columns: ["Category you write", "Model it goes to"],
          rows: [
            ["Quick questions, rewrites, and summaries", "A low-cost open model, such as GLM 5.2"],
            ["Debugging, analysis, and multi-step planning", "A frontier model"],
            ["Anything with customer records, contracts, or personal data", "A private model on your own servers or cloud account"],
            ["Fallback", "Your default model"]
          ]
        },
        bullets: [
          "Add 2 to 12 categories per router.",
          "Set a minimum confidence: if the router isn't sure, the prompt goes to the fallback.",
          "Routing picks a model; it doesn't grant access. To guarantee a team only ever uses private models, also limit which models that team can use."
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
      { icon: "key", title: "Every control admins have", link: { label: "Policies and controls", href: "/guides/ai-policies-and-controls" } }
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
        question: "What is OpenWork Auto routing?",
        answer:
          "A preview feature that sends each prompt to the model you picked for that kind of work, based on categories you describe in plain English, with a fallback when it isn't sure."
      },
      {
        question: "Can Auto routing send sensitive prompts to a private model?",
        answer:
          "Yes. Describe sensitive work as a category, such as customer data or contracts, and point it at a model on your own infrastructure. Pair it with model access rules for a hard guarantee."
      },
      {
        question: "How does the router decide?",
        answer:
          "It reads the newest message, compares it with your category descriptions, and picks the closest match. Below the minimum confidence, it uses your fallback."
      },
      {
        question: "Are the cost numbers exact?",
        answer: "They're close estimates from token counts and published prices. Your provider's invoice is the final number."
      }
    ],
    cta: {
      heading: "Know what AI costs before the invoice.",
      sub: "Limits, usage, and the right model for every prompt.",
      primary: { label: "Get started free", href: "https://app.openworklabs.com?mode=sign-up" },
      secondary: { label: "AI Gateway docs", href: "/docs/ai-gateway/overview" }
    }
  },
  {
    slug: "prevent-shadow-ai",
    label: "Prevent shadow AI",
    title: "How to prevent shadow AI at work",
    description:
      "Shadow AI is staff using unapproved AI tools and personal accounts. Prevent it by giving people a better approved tool, central models, SSO, and enforced policies.",
    heading: "How do you prevent shadow AI?",
    answer:
      "Give people an approved AI tool that's better than the one they'd sneak in, then make it the only path to company data. With OpenWork: a free desktop app with any model, company models through one gateway, SSO, blocks on personal keys and unapproved extensions, and an audit log.",
    updated: "2026-10-10",
    keyFacts: [
      "7 steps, from approved app to audit",
      "50+ model providers to approve from",
      "Provider keys never reach laptops",
      "Self-hosting free up to 5 users"
    ],
    sections: [
      {
        id: "what",
        heading: "What is shadow AI?",
        paragraphs: [
          "Shadow AI is when people use AI tools their company hasn't approved: a personal ChatGPT account, a free browser extension, an unvetted MCP server, or an API key on a personal card. Company data ends up in places security can't see.",
          "People rarely do it to break rules. They do it because the approved tool is missing, slow, or limited to one model, and they have work to finish."
        ]
      },
      {
        id: "why-bans-fail",
        heading: "Why banning AI doesn't work",
        bullets: [
          "Blocking chatgpt.com moves the problem to phones and personal laptops.",
          "A single-vendor tool pushes people elsewhere when they need another model.",
          "Engineers and business teams need different tools, so one mandated app leaves someone out.",
          "Without usage data, you can't tell whether the approved tool is being used at all."
        ]
      },
      {
        id: "steps",
        heading: "Seven steps to stop shadow AI with OpenWork",
        steps: [
          {
            title: "Give everyone an approved agent",
            body: "Roll out the free OpenWork desktop app for macOS, Windows, and Linux. It works on people's own files, so they don't need to upload them to a personal account."
          },
          {
            title: "Provide the models people want",
            body: "Add OpenAI, Anthropic, Google, Bedrock, Vertex, Azure, or a self-hosted model once in the AI Gateway. Keys stay on the server, and each team gets the models it needs."
          },
          {
            title: "Require company sign-in",
            body: "Connect SSO and SCIM, push required sign-in to managed computers, and limit sign-up to your email domains."
          },
          {
            title: "Block personal keys and unapproved extensions",
            body: "Turn on Only models you provide, and use agent permissions to allow only approved local skills and MCP servers."
          },
          {
            title: "Share approved skills and connections",
            body: "Publish skills and connections such as Google Workspace, Microsoft 365, and Slack once, granted per team, so the approved path is also the easy one."
          },
          {
            title: "Cover engineers too",
            body: "Connect OpenCode with the opencode-openwork plugin, and Claude Code, Codex, and Cursor with the OpenWork MCP URL, so engineering tools use the same grants."
          },
          {
            title: "Watch usage and spend",
            body: "Use analytics, spend limits, and the audit log to see adoption by team, catch gaps, and prove control to auditors."
          }
        ]
      },
      {
        id: "checklist",
        heading: "Shadow AI checklist",
        table: {
          caption: "Common shadow AI risks and the OpenWork control for each",
          columns: ["Risk", "OpenWork control"],
          rows: [
            ["Personal ChatGPT or Claude accounts", "Approved desktop app with company models"],
            ["API keys on personal cards", "AI Gateway with keys on the server and Only models you provide"],
            ["Unvetted MCP servers and skills", "Agent permissions for local skills and MCP servers"],
            ["Agents running risky commands", "Agent permissions for commands: Allow, Block, or Ask first"],
            ["Agents browsing unknown sites", "Website allow and block lists"],
            ["Ex-employees keeping access", "SSO and SCIM deprovisioning"],
            ["Runaway spend", "Spend limits per team or person"],
            ["No evidence for auditors", "Audit log and per-member usage"]
          ]
        }
      }
    ],
    cards: [
      { icon: "key", title: "Every control admins have", link: { label: "Policies and controls", href: "/guides/ai-policies-and-controls" } },
      { icon: "users", title: "One policy for engineers and business teams", link: { label: "Read the guide", href: "/guides/engineers-and-business-teams" } },
      { icon: "cloud", title: "Data handling and subprocessors", link: { label: "Trust Center", href: "/trust" } },
      { icon: "monitor", title: "Roll out the desktop app", link: { label: "Enterprise deployment", href: "/docs/start-here/enterprise-desktop-deployment" } }
    ],
    faq: [
      {
        question: "What is shadow AI?",
        answer: "Using AI tools, accounts, or extensions an organization hasn't approved, which sends company data where security can't see or control it."
      },
      {
        question: "Is shadow AI a security risk?",
        answer: "Yes. It can leak confidential data, bypass access controls, and leave no audit trail. It also hides spend."
      },
      {
        question: "Should we just block AI websites?",
        answer: "Blocking alone pushes use to personal devices. Pair it with an approved tool people prefer, then block what's left."
      },
      {
        question: "Does OpenWork lock us into one AI vendor?",
        answer: "No. OpenWork is open source and works with 50+ providers and local models, so you can approve the models people actually want."
      },
      {
        question: "Can we self-host OpenWork?",
        answer: "Yes. OpenWork can run in your own environment, and self-hosting is free for organizations up to 5 users."
      }
    ],
    cta: {
      heading: "Make the approved path the easy one.",
      sub: "Give every team a better AI tool, under your rules.",
      primary: { label: "Talk to us", href: "/enterprise#book" },
      secondary: { label: "Get started free", href: "https://app.openworklabs.com?mode=sign-up" }
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

> Short answers about how OpenWork works with OpenCode, Claude Code, Codex, Cursor, and Ollama, and how admins control AI across a company.

${guides.map((guide) => `- [${guide.heading}](${SITE_URL}${guidePath(guide)}) — ${guide.answer}`).join("\n")}
`;
}
