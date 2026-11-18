/**
 * Copy for /enterprise. Keep claims in step with lib/enterprise.ts (FAQ),
 * lib/agent-markdown.ts (crawler view) and the public roadmap.
 */

export type EnterpriseFact = {
  title: string;
  detail: string;
};

/** Shown under the AI gateway preview in the hero. */
export const enterpriseControls: EnterpriseFact[] = [
  {
    title: "Company identity",
    detail: "SAML or OIDC single sign-on. Provision and deprovision access through SCIM, not another set of personal accounts."
  },
  {
    title: "Explicit permissions",
    detail: "Assign models, skills, and connections by role and team. Administration stays separate from everyday access."
  },
  {
    title: "Your approved providers",
    detail: "Configure providers centrally, including AWS Bedrock. Supported clients get a company model path, not personal keys."
  },
  {
    title: "Visibility into routed usage",
    detail: "Review model usage and spend through the gateway, without claiming visibility into tools that bypass it."
  }
];

export const enterpriseShadowAi = {
  without: [
    "Personal AI accounts",
    "Unmanaged API keys",
    "Company context sent to unapproved providers",
    "No record of what was used"
  ],
  with: [
    "Company sign-in with SSO and SCIM",
    "Approved providers, including AWS Bedrock",
    "Models, skills, and connections by team",
    "Usage and spend for routed traffic"
  ],
  boundary:
    "OpenWork governs model traffic routed through your gateway. It does not find or block personal accounts and tools that bypass it."
};

export type EnterpriseAgentId = "openwork" | "opencode" | "claude-code" | "codex" | "cursor";
export type EnterpriseAccess = "ready" | "in-progress";

export type EnterpriseAgent = {
  id: EnterpriseAgentId;
  name: string;
  via: string;
  skills: EnterpriseAccess;
  models: EnterpriseAccess;
};

export const enterpriseAgents: EnterpriseAgent[] = [
  { id: "openwork", name: "OpenWork", via: "Desktop app", skills: "ready", models: "ready" },
  { id: "opencode", name: "OpenCode", via: "With the opencode-openwork plugin", skills: "ready", models: "ready" },
  { id: "claude-code", name: "Claude Code", via: "Through the MCP gateway", skills: "ready", models: "in-progress" },
  { id: "codex", name: "Codex", via: "Through the MCP gateway", skills: "ready", models: "in-progress" },
  { id: "cursor", name: "Cursor", via: "Through the MCP gateway", skills: "ready", models: "in-progress" }
];

export const enterpriseAgentsNote =
  "AI gateway model integration for Claude Code, Codex, and Cursor is in progress. Connecting an MCP server alone does not route a client’s model traffic.";

export const enterpriseDataPath = {
  local: ["Files and folders", "Workspace processing"],
  provider: ["Prompts and responses", "File content selected as context"]
};

export const enterpriseDataBoundary: EnterpriseFact[] = [
  {
    title: "On the employee’s computer",
    detail: "In the local desktop setup, files and the workspace stay on the computer. SSO configuration and model traffic leave it, not a copy of the workspace."
  },
  {
    title: "Through the model path",
    detail: "Prompts, responses, and file content selected as context travel through the gateway to your provider. Local-first does not mean a remote model never sees company data."
  },
  {
    title: "Other data flows",
    detail: "Product analytics, diagnostics, update checks, optional cloud workers, and connected services have their own flows. Review them with your deployment."
  }
];

export type EnterpriseDeployment = EnterpriseFact & {
  label: string;
  href: string;
  link: string;
};

export const enterpriseDeployments: EnterpriseDeployment[] = [
  {
    label: "macOS, Windows, and Linux",
    title: "Local-first desktop",
    detail: "Start with a per-user install and connect the organization’s approved services.",
    href: "/download",
    link: "Download OpenWork"
  },
  {
    label: "OpenWork Cloud",
    title: "Cloud management",
    detail: "Manage access, models, shared skills, and connections from OpenWork’s control plane.",
    href: "/cloud",
    link: "Explore OpenWork Cloud"
  },
  {
    label: "Your infrastructure",
    title: "Private or self-hosted",
    detail: "A managed private deployment, or self-host it. Agree on operations and responsibility boundaries first.",
    href: "https://github.com/different-ai/openwork/blob/dev/docs/managed-deployments.md",
    link: "Review deployment docs"
  }
];

export const enterpriseRollout: EnterpriseFact[] = [
  {
    title: "Start with a person",
    detail: "Install per user. Connect company sign-in and an approved provider, then test one workflow with a small pilot group."
  },
  {
    title: "Plan a 30-day trial",
    detail: "Validate permissions, review data flows, test the identity lifecycle, and collect feedback from employees and IT."
  },
  {
    title: "Expand in phases",
    detail: "Use the pilot findings to plan a few hundred seats, with deployment, support, and scope agreed first."
  }
];

export const enterpriseRolloutNote =
  "An evaluation plan, not a deployment guarantee. Timeline, scope, support, and commercial terms are agreed with your team.";
