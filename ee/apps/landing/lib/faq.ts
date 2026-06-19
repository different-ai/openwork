export type FaqEntry = {
  question: string;
  answer: string;
};

export const homeFaq: FaqEntry[] = [
  {
    question: "What is OpenWork?",
    answer:
      "OpenWork is a free, open-source desktop app for macOS, Windows, and Linux that lets you do work with AI agents on your own files. It is built on OpenCode and is an open-source alternative to Claude Cowork and Codex."
  },
  {
    question: "Is OpenWork free?",
    answer:
      "Yes. The desktop app is free and open source — you bring your own LLM provider keys. The Team Starter plan includes your first 5 seats free, then $10 per seat per month, and adds API access and the Extension Marketplace. Enterprise plans have custom pricing with SSO and bring-your-own inference."
  },
  {
    question: "How is OpenWork different from Claude Cowork?",
    answer:
      "OpenWork is open source, works with 50+ LLMs from any provider instead of a single vendor, and runs locally so your files stay on your machine. Teams can package skills, MCP servers, plugins, and configs into a single link that teammates import in one click."
  },
  {
    question: "Which AI models does OpenWork support?",
    answer:
      "Any model OpenCode supports — OpenAI, Anthropic, Google, and local models across 50+ providers. You connect your own API keys, or use a managed provider on the cloud plans."
  },
  {
    question: "Does OpenWork send my files to the cloud?",
    answer:
      "No. In desktop mode your files stay on your machine, and prompts are sent directly to the LLM provider you choose. Hosted cloud workers are optional and run on sandboxed infrastructure."
  },
  {
    question: "Do I need to be technical to use OpenWork?",
    answer:
      "No. OpenWork is a point-and-click desktop app. Skills, MCP servers, and plugins shared by a teammate import in one click — no terminal or setup guide required."
  }
];
