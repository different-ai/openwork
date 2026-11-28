import type { CompareCard, CompareSource } from "./compare";
import { anthropicPricingCheckedAt, planPrices } from "./cowork-cost";
import type { FaqEntry } from "./faq";

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
  badge?: string;
  paragraphs?: string[];
  bullets?: string[];
  steps?: GuideStep[];
  table?: GuideTable;
  sources?: CompareSource[];
};

export type Guide = {
  slug: string;
  label: string;
  title: string;
  description: string;
  heading: string;
  answer: string;
  updated: string;
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

const BENCHMARK_PATH = "/docs/benchmarks/overview";
const BENCHMARK_METHOD_PATH = "/docs/benchmarks/how-it-was-run";

const benchmarkSources: CompareSource[] = [
  { label: "Knowledge-work cost benchmark", href: BENCHMARK_PATH },
  { label: "How the benchmark was run", href: BENCHMARK_METHOD_PATH }
];

const claudeSources: CompareSource[] = [
  { label: "Claude plans", href: "https://claude.com/pricing" },
  { label: "Claude Cowork", href: "https://claude.com/product/cowork" },
  { label: "Claude Team plan", href: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan" }
];

const claudePricesChecked = new Date(`${anthropicPricingCheckedAt}T00:00:00Z`).toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC"
});

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

const { claudePro, claudeMax, claudeUltra, claudeTeamStandard, claudeTeamPremium } = planPrices;

function claudeTeamCostRow(people: number): string[] {
  const fitsTeam = people >= planPrices.claudeTeamMinSeats && people <= planPrices.claudeTeamMaxSeats;
  const enterpriseSeats = Math.max(people, planPrices.claudeEnterpriseMinSeats);
  const enterprise = usd(enterpriseSeats * planPrices.claudeEnterpriseSeat);
  return [
    `${people.toLocaleString("en-US")} people`,
    fitsTeam ? usd(people * claudeTeamStandard.annual) : `Not offered above ${planPrices.claudeTeamMaxSeats} seats`,
    fitsTeam ? usd(people * claudeTeamPremium.annual) : `Not offered above ${planPrices.claudeTeamMaxSeats} seats`,
    enterpriseSeats > people ? `${enterprise} (${planPrices.claudeEnterpriseMinSeats}-seat minimum)` : enterprise
  ];
}

export const guides: Guide[] = [
  {
    slug: "openwork-and-opencode",
    label: "OpenWork and OpenCode",
    title: "OpenWork vs OpenCode: how they work together",
    description:
      "OpenWork is built on OpenCode. Use the OpenWork desktop app, or add the opencode-openwork plugin to OpenCode to get your organization's models and MCP connections.",
    heading: "How does OpenWork work with OpenCode?",
    answer:
      "OpenWork runs on OpenCode, the open-source coding agent. The desktop app gives anyone a point-and-click OpenCode, and the opencode-openwork plugin brings your organization's models, skills, and connections into OpenCode in a terminal.",
    updated: "2026-10-11",
    keyFacts: [
      "Engine: OpenCode, on macOS, Windows, and Linux",
      "Plugin: opencode-openwork, for OpenCode 2",
      "Refreshes models and connections every 5 minutes",
      "License: open source, free desktop app"
    ],
    sections: [
      {
        id: "openwork-connect",
        heading: "What is OpenWork Connect?",
        paragraphs: [
          "OpenWork Connect is an AI Gateway, MCP Gateway, and Skills Gateway that lets organizations centrally manage models, tools, reusable skills, and access from one admin panel.",
          "In OpenCode, the opencode-openwork plugin brings all three in with one sign-in. You don't need the OpenWork desktop app."
        ],
        bullets: [
          "AI Gateway: approved models, without giving people provider keys. Usage and spend limits in one place.",
          "MCP Gateway: connected tools, such as Slack or Google Workspace, for the people allowed to use them.",
          "Skills Gateway: reusable instructions your team publishes once and every agent can use."
        ]
      },
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
      "OpenWork Cloud Free plan: up to 5 users"
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
        answer: "Yes, an OpenWork Cloud account. The Free plan covers up to 5 users."
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
        ],
        paragraphs: [
          "How much cheaper depends on the work. In our benchmark, a low-cost model with a one-page skill held quality against Claude Opus 5.5 at 11% of the cost, and the same model without the skill did not."
        ],
        sources: benchmarkSources
      }
    ],
    cards: [
      { icon: "route", title: "Spend limits and model access", link: { label: "AI Gateway", href: "/docs/ai-gateway/overview" } },
      { icon: "library", title: "Spend less on each task", link: { label: "Reduce LLM costs", href: "/guides/reduce-llm-costs" } },
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
    slug: "reduce-llm-costs",
    label: "Reduce LLM costs",
    title: "How to reduce LLM costs at your organization, benchmarked",
    description:
      "Cut LLM spend with skills, cheaper subagents, model routing, and spend limits. In our benchmark, a low-cost model with a one-page skill held quality at 11% of the cost.",
    heading: "How do you reduce LLM costs at your organization?",
    answer:
      "Write a skill for the work your team repeats so a cheaper model can lead it, route each task to the cheapest model that holds quality, and set spend limits. In our 41-run benchmark, a low-cost model with a one-page skill held quality against Claude Opus 5.5 at 11% of the cost.",
    updated: "2026-11-27",
    keyFacts: [
      "Claude Opus 5.5 alone: $10.34 a run, the quality bar",
      "DeepSeek V4.1 Flash with a skill: $1.17 a run, held quality",
      "Skill-aware router with a skill: $0.74 a run, held quality",
      "41 runs of one task, list prices from November 2026"
    ],
    sections: [
      {
        id: "where-the-money-goes",
        heading: "Where LLM spend goes",
        paragraphs: [
          "An agent does not read your data once. It works in steps, and it re-reads its growing context at every step. In our benchmark, Claude Opus 5.5 took about 110 steps to finish one task. The sources were roughly 400,000 tokens, but in the cheapest Opus run $3.50 went to adding new text to the cache, $2.87 to writing output, and $1.61 to re-reading cached context.",
          "So two things move the bill: the price of the model that leads the task, and how many steps it takes. Every lever below changes one of them."
        ],
        sources: benchmarkSources
      },
      {
        id: "benchmark",
        heading: "What we measured",
        paragraphs: [
          "The task is one we do every week: bring a customer knowledge base up to date from two weeks of calls, Slack threads, and email, about 1.55 million characters. We planted 20 facts with known answers in those sources. Claude Opus 5.5 working alone is the bar, and a setup holds quality when, on average, it is at most one planted fact and one sampled row worse than that bar.",
          "This is one task on one team's data, with two or three runs per setup. It compares setups against the same work with the same checks. It is not proof that a setup will hold up on your work."
        ],
        table: {
          caption: "Cost and quality of one run for each setup in the knowledge-work cost benchmark",
          columns: ["Setup", "Cost per run", "Against Opus alone", "Planted facts right", "Held quality"],
          rows: [
            ["Opus alone", "$10.34", "100%", "19.7 of 20", "The bar"],
            ["Sonnet with a skill", "$9.13", "88%", "20.0 of 20", "Yes"],
            ["Router", "$6.93", "67%", "20.0 of 20", "Yes"],
            ["Opus with DeepSeek workers", "$5.14", "50%", "20.0 of 20", "Yes"],
            ["DeepSeek with a skill", "$1.17", "11%", "19.3 of 20", "Yes"],
            ["Skill-aware router with a skill", "$0.74", "7%", "19.3 of 20", "Yes"],
            ["Haiku with a skill", "$0.56", "5%", "17.0 of 20", "No"],
            ["DeepSeek alone", "$0.38", "4%", "16.7 of 20", "No"]
          ]
        },
        sources: benchmarkSources
      },
      {
        id: "skills",
        heading: "Write a skill for work you repeat",
        paragraphs: [
          "A skill is a short written procedure the agent follows. Ours is one page: read every source in date order, decide what counts as a fact, put it on the right customer, and let the latest statement win. It names no fact from the data.",
          "DeepSeek V4.1 Flash alone got 16.7 of 20 planted facts right. With the skill it got 19.3, against 19.7 for Claude Opus 5.5, and a run cost $1.17 instead of $10.34. The skill is what let a cheap model lead.",
          "It depends on the model. The same skill did not lift Claude Haiku 5.5 to the bar, and one of the three DeepSeek runs took 75 minutes and cost $2.40. Test a skill on your own work before you rely on it."
        ]
      },
      {
        id: "subagents",
        heading: "Give the reading to cheaper subagents",
        paragraphs: [
          "Here the expensive model leads and a cheap model does the reading. With Opus leading and DeepSeek workers, quality stayed at 20 of 20 and a run cost $5.14, half of Opus alone.",
          "It stops there. Opus was still 93% of what was left, because the lead holds the workers' reports, decides what is true, and writes the result. Workers also need to be much cheaper than the lead: with Sonnet workers the saving was 9%."
        ]
      },
      {
        id: "model-routing",
        heading: "Use a model router, and tell it about your skills",
        paragraphs: [
          "A model router picks the model for each request so nobody has to. The router in this benchmark was a prototype built for it. Reading only the prompt, it kept Opus in charge and, in two of three runs, sent the reading to DeepSeek. That saved a third on average.",
          "Told which skills exist in the workspace, the same router gave the whole task to DeepSeek whenever a skill covered it: 19.3 of 20 at $0.74 a run, 7% of Opus alone. It was the cheapest setup that held quality.",
          "In OpenWork, the Smart Model Router is part of the AI Gateway. Admins tag each model with the tasks it is good at, members pick Smart instead of a model, and each reply shows which model answered."
        ]
      },
      {
        id: "cost-per-task",
        heading: "Compare cost per finished task, not price per token",
        paragraphs: [
          "Claude Sonnet 5.5 costs half of Opus per token. It took 171 and 265 steps where Opus takes about 110, so a run cost $9.13, 88% of Opus alone. A cheaper model is not always a cheaper run."
        ],
        steps: [
          {
            title: "Pick a task your team repeats",
            body: "Use real inputs and one fixed instruction, the same for every run."
          },
          {
            title: "Plant facts with known answers",
            body: "Include facts that change, facts that get corrected, and ideas that were turned down. Those are where cheap models slip."
          },
          {
            title: "Set the bar and the pass rule first",
            body: "Run your best model alone, and decide how far below it a cheaper setup may fall before you look at any result."
          },
          {
            title: "Run each setup at least three times",
            body: "Count every model call, subagents included. Single runs of the same setup ranged from 16 to 20 planted facts in our benchmark."
          }
        ]
      },
      {
        id: "limits",
        heading: "Set limits so a mistake stays small",
        bullets: [
          "Put provider keys under the organization, so spend is in one place instead of on personal cards.",
          "Set a daily, weekly, or monthly spend limit for everyone, a team, or one person.",
          "Review usage by model, team, or person, and grant the most expensive models only to the teams that need them.",
          "Use local models for work that can run on a laptop. They cost nothing per token."
        ]
      }
    ],
    cards: [
      { icon: "library", title: "Read the full benchmark", link: { label: "Benchmark results", href: BENCHMARK_PATH } },
      { icon: "route", title: "Let OpenWork pick the model", link: { label: "Smart Model Router", href: "/docs/ai-gateway/auto-model-routing" } },
      { icon: "key", title: "Set spend limits and see usage", link: { label: "Keep AI costs under control", href: "/guides/control-ai-costs" } },
      { icon: "users", title: "Write and share a skill", link: { label: "Skills", href: "/docs/start-here/do-work-with-it/skills-plugins-and-mcp" } }
    ],
    faq: [
      {
        question: "What is the fastest way to reduce LLM costs?",
        answer:
          "Find the work your team repeats, write a skill for it, and let a cheaper model lead it. In our benchmark that took one task from $10.34 to $1.17 a run while holding quality."
      },
      {
        question: "Does an LLM router reduce costs?",
        answer:
          "It depends on what the router knows. In our benchmark, a router that only read the prompt saved a third. The same router, told which skills exist, cut the cost to 7% of Claude Opus 5.5 alone."
      },
      {
        question: "Do subagents reduce LLM costs?",
        answer:
          "By about half in our benchmark, when the workers were much cheaper than the lead. The lead model was still about 90% of the remaining cost."
      },
      {
        question: "Is a cheaper model always cheaper to run?",
        answer:
          "No. Claude Sonnet 5.5 costs half of Opus per token but took more steps, so a run cost 88% of Opus alone. Compare the cost of a finished task."
      },
      {
        question: "Is DeepSeek as good as Claude Opus for agent work?",
        answer:
          "Not on its own in our benchmark: DeepSeek V4.1 Flash got 16.7 of 20 planted facts right, against 19.7 for Claude Opus 5.5. With a one-page skill it got 19.3 at 11% of the cost. That is one task, so test your own."
      },
      {
        question: "How do I stop a team from overspending on LLMs?",
        answer:
          "Put provider keys under the organization and set daily, weekly, or monthly spend limits per person or team. In OpenWork this is the AI Gateway."
      }
    ],
    cta: {
      heading: "Spend less on the same work.",
      sub: "Skills, model routing, and spend limits in one place.",
      primary: { label: "Get started free", href: "https://app.openworklabs.com?mode=sign-up" },
      secondary: { label: "See the benchmark", href: BENCHMARK_PATH }
    }
  },
  {
    slug: "claude-cowork-pricing",
    label: "Claude Cowork pricing",
    title: "Claude Cowork pricing: what each plan costs and includes",
    description: `Claude Cowork is included in Claude's paid plans, from ${usd(claudePro.monthly)} a month on Pro. Plan prices, usage limits, and what a team pays, checked ${claudePricesChecked}.`,
    heading: "How much does Claude Cowork cost?",
    answer: `Claude Cowork is included in Claude's paid plans and is not on the Free plan. As of ${claudePricesChecked}, that is Pro at ${usd(claudePro.monthly)} a month, Max at ${usd(claudeMax)}, Ultra at ${usd(claudeUltra)}, Team from ${usd(claudeTeamStandard.annual)} a seat, and Enterprise at ${usd(planPrices.claudeEnterpriseSeat)} a seat plus usage at API rates.`,
    updated: anthropicPricingCheckedAt,
    keyFacts: [
      "Free plan: Cowork is not included",
      `Pro: ${usd(claudePro.monthly)} a month, or ${usd(claudePro.annual)} billed annually`,
      `Team: ${usd(claudeTeamStandard.annual)} to ${usd(claudeTeamPremium.monthly)} a seat a month`,
      `Prices checked ${claudePricesChecked}`
    ],
    sections: [
      {
        id: "plans",
        heading: "Claude Cowork price by plan",
        paragraphs: [
          "Cowork is not sold on its own. Anthropic includes it in every paid Claude plan, and is folding it into Claude itself, starting with Pro, Max, and Ultra. Prices are Anthropic's US list prices before tax."
        ],
        table: {
          caption: "Claude plans that include Cowork, with list prices",
          columns: ["Plan", "Price", "Cowork", "Usage"],
          rows: [
            ["Free", "$0", "Not included", "Cowork needs a paid plan"],
            [
              "Pro",
              `${usd(claudePro.monthly)} a month, or ${usd(claudePro.annual)} a month billed annually (${usd(claudePro.annualUpFront)} up front)`,
              "Included",
              "Suited to quick tasks. Cowork uses limits faster than chat"
            ],
            ["Max", `${usd(claudeMax)} a month`, "Included", "5x the usage of Pro"],
            ["Ultra", `${usd(claudeUltra)} a month`, "Included", "10x the weekly usage of Pro"],
            [
              "Team, Standard seat",
              `${usd(claudeTeamStandard.monthly)} a seat a month, or ${usd(claudeTeamStandard.annual)} billed annually`,
              "Included",
              `1.25x the Pro allowance per session. ${planPrices.claudeTeamMinSeats} to ${planPrices.claudeTeamMaxSeats} seats`
            ],
            [
              "Team, Premium seat",
              `${usd(claudeTeamPremium.monthly)} a seat a month, or ${usd(claudeTeamPremium.annual)} billed annually`,
              "Included",
              "5x the usage of a Standard seat"
            ],
            [
              "Enterprise",
              `${usd(planPrices.claudeEnterpriseSeat)} a seat a month, billed annually, ${planPrices.claudeEnterpriseMinSeats}-seat minimum`,
              "Included. Admins control access",
              "Billed on top of the seat, at API rates"
            ]
          ]
        },
        sources: claudeSources
      },
      {
        id: "limits",
        heading: "Usage limits and extra cost",
        paragraphs: [
          "The plan price is a floor. Anthropic says agentic tasks use more capacity than chat, because Claude coordinates sub-agents and tool calls to finish the work.",
          "Chat, Cowork, and Claude Code draw from the same allowance. Most accounts have a limit that resets every five hours, and paid plans add a weekly limit. There is no fixed message count: it depends on the model and the length of the task.",
          "When you reach a limit you can wait for it to reset, move to a higher plan, or turn on usage credits and keep working at standard API rates. On Enterprise, usage is billed at API rates from the start."
        ],
        sources: claudeSources
      },
      {
        id: "team-cost",
        heading: "What a team pays for seats",
        paragraphs: [
          "Seat cost per month with annual billing, at list price, before any usage credits or API usage."
        ],
        table: {
          caption: "Monthly Claude seat cost by team size, with annual billing",
          columns: ["Team size", "Team, Standard seats", "Team, Premium seats", "Enterprise seats, before usage"],
          rows: [10, 50, 150, 500].map(claudeTeamCostRow)
        },
        sources: claudeSources
      },
      {
        id: "free-alternative",
        heading: "A free, open-source alternative",
        paragraphs: [
          "OpenWork is a free, open-source desktop app for the same kind of work: agents on your files, skills, scheduled tasks, and browser automation. It runs on macOS, Windows, and Linux with any model, including Claude.",
          "The cost works differently. With your own API key you pay your model provider per token, and with a local model you pay nothing per token. Heavy use of a frontier model on a key can cost more than a flat plan, which is why teams pair OpenWork with cheaper models, skills, and spend limits."
        ],
        bullets: [
          "Desktop app: free, with no account needed.",
          `OpenWork Cloud: Free for up to ${planPrices.openworkFreeSeats} users, then Team at ${usd(planPrices.openworkTeamSeat)} per user a month.`,
          "Your SKILL.md skills, plugins, and MCP servers carry over from Cowork."
        ]
      }
    ],
    cards: [
      { icon: "migrate", title: "Compare features and cost for your team size", link: { label: "OpenWork vs Claude Cowork", href: "/alternatives/claude-cowork" } },
      { icon: "cloud", title: "On Bedrock, Vertex, or Foundry?", link: { label: "Compare with Claude on 3P", href: "/alternatives/claude-cowork-3p" } },
      { icon: "key", title: "Pay less for the same task", link: { label: "Reduce LLM costs", href: "/guides/reduce-llm-costs" } },
      { icon: "monitor", title: "Try the free desktop app", link: { label: "Download", href: "/download" } }
    ],
    faq: [
      {
        question: "Is Claude Cowork free?",
        answer: `No. Anthropic says Cowork works with a paid plan. The lowest-priced plan that includes it is Pro, at ${usd(claudePro.monthly)} a month or ${usd(claudePro.annual)} a month billed annually, checked ${claudePricesChecked}.`
      },
      {
        question: "How much does Claude Cowork cost per month?",
        answer: `${usd(claudePro.monthly)} on Pro, ${usd(claudeMax)} on Max, and ${usd(claudeUltra)} on Ultra. Team seats are ${usd(claudeTeamStandard.monthly)} (Standard) or ${usd(claudeTeamPremium.monthly)} (Premium) billed monthly, and Enterprise is ${usd(planPrices.claudeEnterpriseSeat)} a seat plus usage at API rates.`
      },
      {
        question: "Is Claude Cowork included in Claude Pro?",
        answer:
          "Yes. Anthropic notes that Cowork uses limits faster than chat and suggests a higher plan for heavy use."
      },
      {
        question: "Does Claude Cowork have usage limits?",
        answer:
          "Yes. Cowork shares one allowance with chat and Claude Code, with a five-hour limit and a weekly limit on paid plans. Past the limit, usage credits are billed at API rates."
      },
      {
        question: "Is Claude Cowork a separate subscription?",
        answer:
          "No. It is part of Claude's paid plans, and Anthropic is folding it into Claude itself, starting with Pro, Max, and Ultra."
      },
      {
        question: "Is there a free alternative to Claude Cowork?",
        answer:
          "Yes. OpenWork is a free, open-source desktop app for macOS, Windows, and Linux that works with any model, including local ones."
      }
    ],
    cta: {
      heading: "The same kind of work, on any model.",
      sub: "Free and open source, with your own keys or local models.",
      primary: { label: "Download OpenWork free", href: "/download" },
      secondary: { label: "Compare with Claude Cowork", href: "/alternatives/claude-cowork" }
    }
  },
  {
    slug: "self-hosted-ai-agent",
    label: "Self-hosted AI agent",
    title: "Self-hosted AI agent: run OpenWork on your own infrastructure",
    description:
      "Run an AI agent on your own computers, models, and cloud. OpenWork is a free desktop app with local models and a Helm chart for AWS, Azure, and Google Cloud.",
    heading: "How do you run a self-hosted AI agent?",
    answer:
      "Run the agent on each person's computer, point it at a model you control, and host sign-in, teams, and access in your own cloud. OpenWork covers all three: a free open-source desktop app, local or private models, and a Helm chart for AWS, Azure, and Google Cloud.",
    updated: "2026-11-27",
    keyFacts: [
      "Desktop app: MIT license, macOS, Windows, and Linux",
      "Models: Ollama, vLLM, or any OpenAI-compatible server",
      "Control plane: Helm on Amazon EKS, Azure AKS, or Google GKE",
      "Self-hosting is free for up to 5 users"
    ],
    sections: [
      {
        id: "what-it-means",
        heading: "What self-hosted means for an AI agent",
        paragraphs: [
          "An AI agent has three parts, and each can run on your side or someone else's. Decide which ones you need to control before you pick a setup."
        ],
        table: {
          caption: "The parts of an AI agent and how each is self-hosted with OpenWork",
          columns: ["Part", "What it does", "Self-hosted with OpenWork"],
          rows: [
            ["Agent", "Reads files, runs tools, and does the work", "The desktop app on each computer. Files stay on that computer."],
            [
              "Model",
              "Answers each prompt",
              "Ollama or LM Studio on the computer, vLLM or another OpenAI-compatible server on your network, or your own cloud account."
            ],
            [
              "Control plane",
              "Sign-in, teams, access, and shared skills and connections",
              "OpenWork's web app and API in your cloud, with a MySQL 8-compatible database."
            ],
            ["AI Gateway (optional)", "Routes and counts model requests, with spend limits", "OpenWork Gateway, in the same deployment."]
          ]
        }
      },
      {
        id: "one-computer",
        heading: "Start on one computer",
        steps: [
          {
            title: "Download OpenWork",
            body: "Install the desktop app for macOS, Windows, or Linux. No account is needed."
          },
          {
            title: "Add a local model",
            body: "Start Ollama, open Settings › Ollama in OpenWork, pick or pull a model, and click Add to workspace.",
            code: "ollama pull qwen2.5-coder:7b"
          },
          {
            title: "Open a folder and give it a task",
            body: "The agent works on the files in that folder, and model requests go to Ollama on the same computer. Web tools, connectors, and updates can still use the network when they are turned on."
          }
        ]
      },
      {
        id: "docker-compose",
        heading: "Try the control plane with Docker Compose",
        paragraphs: [
          "The Docker Compose stack runs the web app, the API, and MySQL on one machine from published images, with nothing to clone or build. It opens at http://localhost:3005.",
          "It is for evaluation only. It uses development credentials and allows public signup, so keep it off your network and away from production data."
        ]
      },
      {
        id: "production",
        heading: "Deploy to your own cloud",
        paragraphs: [
          "Production runs on managed Kubernetes with the published Helm chart. The guides cover managed MySQL, ingress, DNS, TLS, database migrations, and creating the first administrator."
        ],
        table: {
          caption: "Self-hosted deployment options for OpenWork",
          columns: ["Option", "Best for"],
          rows: [
            ["Docker Compose", "Evaluating on one machine"],
            ["Helm on Amazon EKS", "Production on AWS with Amazon RDS for MySQL"],
            ["Helm on Azure AKS", "Production on Azure with Azure Database for MySQL"],
            ["Helm on Google GKE", "Production on Google Cloud with Cloud SQL for MySQL"],
            ["Terraform modules (beta)", "The web app and API on ECS Fargate, Cloud Run, or Container Apps"],
            ["Another container platform", "Teams that maintain their own infrastructure code, using the published images"]
          ]
        }
      },
      {
        id: "helm",
        heading: "Install with Helm",
        steps: [
          {
            title: "Prepare your cloud",
            body: "Create the Kubernetes cluster, the MySQL 8-compatible database, and HTTPS hostnames for the web app and the API."
          },
          {
            title: "Install the chart",
            body: "Pin the chart version and pass your own values file.",
            code: "helm upgrade --install openwork-ee oci://ghcr.io/different-ai/charts/openwork-ee \\\n  --version <chart-version> \\\n  -f values.prod.yaml"
          },
          {
            title: "Finish setup",
            body: "Run the database migrations and create the first administrator. The guide for your cloud has the exact steps."
          }
        ]
      },
      {
        id: "private-networks",
        heading: "Private networks and air-gapped sites",
        paragraphs: [
          "The common setup keeps the control plane on a private network and lets laptops reach it over VPN. A fully isolated deployment is more work: every dependency of the features you turn on has to be mirrored, provisioned, or switched off, including images, installers, model catalogs, and MCP servers. The docs have a checklist for each."
        ]
      },
      {
        id: "models",
        heading: "Self-hosted models for a team",
        bullets: [
          "Run Ollama or vLLM behind an address your team can reach, and add it once as a custom provider. It shows up on everyone's desktop.",
          "Route it through the AI Gateway to choose who can use it and to count usage per person.",
          "Turn on Only models you provide to stop people adding their own providers."
        ]
      },
      {
        id: "cost",
        heading: "What self-hosting costs",
        bullets: [
          "The desktop app is MIT-licensed and free for any use.",
          "The control plane is source-available, so your security team can read what you deploy. It is free in production for organizations of up to 5 users.",
          "Larger teams can evaluate every feature for 30 days, then need a plan. Terms are the same for OpenWork Cloud and self-hosted, with no deployment fee.",
          "You pay your cloud provider for the infrastructure and your model provider for tokens."
        ]
      }
    ],
    cards: [
      { icon: "cloud", title: "Deploy on AWS, Azure, or Google Cloud", link: { label: "Deploy to your cloud", href: "/docs/self-host/deploy-to-your-cloud/overview" } },
      { icon: "monitor", title: "Try it on one machine first", link: { label: "Docker Compose", href: "/docs/self-host/evaluate-with-docker-compose" } },
      { icon: "cpu", title: "Run models on your own hardware", link: { label: "OpenWork with Ollama", href: "/guides/ollama" } },
      { icon: "key", title: "Plans and licensing", link: { label: "Pricing and licensing", href: "/docs/start-here/pricing-and-licensing" } }
    ],
    faq: [
      {
        question: "Can I self-host an AI agent for free?",
        answer:
          "Yes. The OpenWork desktop app is free and open source, and a local model adds no cost per token. Self-hosting the team control plane is free for organizations of up to 5 users."
      },
      {
        question: "Which models work with a self-hosted AI agent?",
        answer:
          "Any model behind an OpenAI-compatible API, including Ollama, LM Studio, llama.cpp, and vLLM. You can also use your own Amazon Bedrock, Google Vertex AI, or Azure account."
      },
      {
        question: "Does a self-hosted AI agent work offline?",
        answer:
          "Chat on your files works offline once a local model is downloaded. Web tools and online connectors need a network."
      },
      {
        question: "Can OpenWork run in an air-gapped environment?",
        answer:
          "It can be planned for. A fully isolated deployment means mirroring or switching off every dependency of the features you use. The air-gapped deployment docs list them."
      },
      {
        question: "What do I need to run OpenWork in production?",
        answer:
          "A managed Kubernetes cluster on AWS, Azure, or Google Cloud, a MySQL 8-compatible database, and HTTPS hostnames for the web app and the API."
      },
      {
        question: "Is OpenWork open source?",
        answer:
          "The desktop app and core platform are MIT-licensed. The organization control plane is source-available under the OpenWork EE License, and each release converts to MIT two years after publication."
      },
      {
        question: "Is there a self-hosted alternative to Claude Cowork?",
        answer:
          "Yes. OpenWork does the same kind of work with any model, and you can run the app, the models, and the control plane on your own infrastructure."
      }
    ],
    cta: {
      heading: "Your agents, on your infrastructure.",
      sub: "Start on one computer, then deploy to your own cloud.",
      primary: { label: "Download OpenWork free", href: "/download" },
      secondary: { label: "Self-host docs", href: "/docs/start-here/self-host" }
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
  if (section.sources) {
    parts.push(`Sources: ${section.sources.map((source) => `[${source.label}](${absolute(source.href)})`).join(", ")}`);
  }
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

> Short answers about OpenWork with OpenCode, MCP clients, and local models, plus self-hosting, Claude Cowork pricing, and how to spend less on LLMs.

${guides.map((guide) => `- [${guide.heading}](${SITE_URL}${guidePath(guide)}) — ${guide.answer}`).join("\n")}
`;
}
