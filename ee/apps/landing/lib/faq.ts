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
      "Yes. The desktop app is free and open source — you bring your own LLM provider keys. On OpenWork Cloud, the Free plan covers up to 5 users. The Team plan is $10 per user per month and adds SSO, API access, and the Extension Marketplace. Enterprise adds SCIM, desktop policies, and bring-your-own inference."
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

export const aiGatewayFaq: FaqEntry[] = [
  {
    question: "Which providers does AI Gateway support?",
    answer:
      "OpenAI, Anthropic, Google Gemini, Google Vertex AI (including Claude on Vertex), Azure OpenAI, Microsoft Foundry (Claude), Amazon Bedrock, Mistral, OpenRouter, LiteLLM, and compatible catalog providers. The provider support page in the docs lists the credentials and APIs each one supports."
  },
  {
    question: "Do members ever see a provider key?",
    answer:
      "No. Provider keys are stored encrypted on the server and only the gateway reads them. Each member gets one AI Gateway key, which proves who is asking and only reaches the models that person is allowed to use."
  },
  {
    question: "How is this different from OpenWork Models or bringing your own keys?",
    answer:
      "AI Gateway routes your own providers through OpenWork with access rules, limits, and usage tracking. OpenWork Models is a managed subscription with no keys, billed separately. With your own keys in the desktop app, the app calls the provider directly and nothing is shared with a team."
  },
  {
    question: "How accurate is the cost view?",
    answer:
      "Costs are estimates from the tokens each provider reports and public model prices, or the cost a provider reports when it returns one. They are not your provider's bill."
  },
  {
    question: "What does AI Gateway cost?",
    answer:
      "Shared provider keys are on the Team plan at $10 per user per month. Spend observability and the audit log are on Enterprise. The same terms apply on OpenWork Cloud and self-hosted. Your providers bill model usage."
  },
  {
    question: "Can I keep LiteLLM or Bifrost?",
    answer:
      "Yes. Add your LiteLLM proxy as a provider and OpenWork syncs its models and teams. Other OpenAI-compatible gateways can be added as a custom provider."
  }
];

export const desktopFaq: FaqEntry[] = [
  {
    question: "Is the OpenWork desktop app free?",
    answer:
      "Yes. The desktop app is free and open source under the MIT license. You bring your own model: a provider API key, a ChatGPT sign-in, or a local model."
  },
  {
    question: "Do I need an account?",
    answer:
      "No. Chat on your files, your own models, local skills, and custom MCP servers all work signed out. Signing in to OpenWork Cloud is optional and adds automations, shared skills, and the connections your team shares."
  },
  {
    question: "Does OpenWork send my files to the cloud?",
    answer:
      "No. In desktop mode your files stay on your computer, and prompts go directly to the model provider you choose. With a local model, prompts stay on your computer too."
  },
  {
    question: "Which operating systems does it run on?",
    answer:
      "macOS on Apple Silicon and Intel, Windows on x64 and ARM64, and Linux on x64 and ARM64 as an AppImage. On macOS you can also install it with Homebrew."
  },
  {
    question: "Which models can I use?",
    answer:
      "Any model OpenCode supports: Claude, GPT, Gemini, Mistral, and local models through Ollama, LM Studio, or any OpenAI-compatible server, across 50+ providers."
  },
  {
    question: "Do I need to be technical to use it?",
    answer:
      "No. OpenWork is a point-and-click app. You pick a folder, choose a model, and type what you want done. Skills and connections shared by a teammate are added in one click."
  }
];

export const cloudFaq: FaqEntry[] = [
  {
    question: "What is OpenWork Cloud?",
    answer:
      "OpenWork Cloud is where a team runs OpenWork together. Admins invite members, share skills, connections, and models, and set policies. Members get them in the desktop app and OpenWork Web, and their skills and connections in any MCP client."
  },
  {
    question: "Is OpenWork Cloud free?",
    answer:
      "The Free plan covers up to 5 users. The Team plan is $10 per user per month and adds unlimited users, SSO, the Extension Marketplace, model keys shared with your team, and cloud automations. Enterprise adds SCIM, desktop policies, the audit log, and spend observability. Prices exclude taxes."
  },
  {
    question: "What is OpenWork Web?",
    answer:
      "OpenWork Web is the full OpenWork app in a browser tab, running on a cloud computer for each member. It is an add-on at $50 per member per month. It sleeps when idle and keeps your files for the next time you open it."
  },
  {
    question: "Do I need Cloud to use the desktop app?",
    answer:
      "No. The desktop app stays free and works without an account. Use Cloud when a team needs to share and manage skills, connections, models, and policies."
  },
  {
    question: "Can we self-host it?",
    answer:
      "Yes. The full platform can run on your own infrastructure with Docker Compose for evaluation or Helm on Kubernetes for production. Self-hosting is free for organizations of up to 5 users, and the same plans apply beyond that."
  },
  {
    question: "How do members sign in?",
    answer:
      "With a work email by default. The Team plan adds single sign-on with any SAML or OIDC identity provider, such as Okta, Microsoft Entra, or Google Workspace. Enterprise adds SCIM provisioning."
  }
];

/** schema.org FAQPage for a page's visible FAQ. */
export function faqSchema(entries: FaqEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: entry.answer
      }
    }))
  };
}
