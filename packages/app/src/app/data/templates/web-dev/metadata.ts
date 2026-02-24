import type { AikaTemplate } from "../index";

import webDevStandards from "./skills/web-dev-standards.md?raw";
import deploymentChecklist from "./skills/deployment-checklist.md?raw";
import scaffoldPage from "./commands/scaffold-page.md?raw";
import auditPerformance from "./commands/audit-performance.md?raw";
import generateApi from "./commands/generate-api.md?raw";

const template: AikaTemplate = {
  id: "web-dev",
  name: "Web Development",
  description: "Full-stack web development with Next.js, Tailwind, and modern tooling.",
  icon: "Code2",
  locale: "en",
  category: "function",
  audience: "Developers, agencies, freelancers",
  skills: [
    { slug: "web-dev-standards", content: webDevStandards },
    { slug: "deployment-checklist", content: deploymentChecklist },
  ],
  commands: [
    { slug: "scaffold-page", content: scaffoldPage },
    { slug: "audit-performance", content: auditPerformance },
    { slug: "generate-api", content: generateApi },
  ],
  suggestedMcps: [
    {
      name: "Browser Automation",
      package: "@anthropic/browser-mcp",
      reason: "Visual testing and screenshot verification during development.",
    },
    {
      name: "GitHub",
      package: "@anthropic/github-mcp",
      reason: "Create PRs, manage issues, and review code directly from the worker.",
    },
  ],
};

export default template;
