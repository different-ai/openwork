export const FAQS = [
  {
    title: "What is OpenWork?",
    content: [
      "OpenWork is the open-source alternative to Claude Cowork and Codex. It is a desktop app, a CLI orchestrator, and a cloud platform for creating, sharing, and consuming agentic workflows.",
      "It runs locally on your machine in one click, and is built on top of OpenCode — so anything OpenCode can do (skills, plugins, MCP, agents, slash commands), OpenWork inherits.",
    ],
  },
  {
    title: "How is OpenWork different from Claude Cowork or Codex?",
    content: [
      "Cowork and Codex are closed, hosted, and tied to a single provider. OpenWork is open-source, local-first, provider-agnostic, and standards-based.",
      "OpenWork lets Bob the IT guy package agentic workflows once, and Susan the accountant consumes them from her desktop, Slack, or Telegram — without any vendor lock-in.",
    ],
  },
  {
    title: "Where do my agents actually run?",
    content: [
      "By default, agents run on your local computer — your filesystem, your credentials, your machine. Nothing leaves unless you opt in.",
      "When you need scale, you can launch hosted OpenWork Cloud workers (Den sandbox workers) and connect from any client with `Add a worker` → `Connect remote`.",
    ],
  },
  {
    title: "Which LLM providers does OpenWork support?",
    content: [
      "Anthropic, OpenAI, Google (Gemini), Mistral, Groq, and any provider OpenCode supports — including local models via Ollama.",
      "Bring your own API keys, or route through your enterprise gateway. OpenWork stays out of the way.",
    ],
  },
  {
    title: "How do skills and plugins work?",
    content: [
      "Skills are folders in `.opencode/skills/<skill-name>` that bundle prompts, rules, tools, and slash commands. Plugins extend OpenCode itself.",
      "OpenWork ships a Skill Manager so you can list, install, and share skills — and organizations can publish a managed skill hub for their team.",
    ],
  },
  {
    title: "Is OpenWork really free?",
    content: [
      "The desktop app, the orchestrator CLI (`npm i -g openwork-orchestrator`), and the source on GitHub are free and open-source.",
      "Hosted Cloud workers and the Enterprise plan (SSO, SLA, LTS, dedicated support) are paid — see the pricing page.",
    ],
  },
  {
    title: "Can I run OpenWork on Windows?",
    content: [
      "macOS and Linux downloads ship directly. Windows access is currently handled through the paid support plan while we stabilize the Tauri build.",
      "If you need Windows today, see the Windows support tier on the pricing page.",
    ],
  },
  {
    title: "How does my team share workflows?",
    content: [
      "Organizations publish shared skill hubs so members discover approved skills from one managed place — no more local-only installs by hand.",
      "Pair that with the orchestrator CLI and your team gets a repeatable, productized process for every agent you ship.",
    ],
  },
];
