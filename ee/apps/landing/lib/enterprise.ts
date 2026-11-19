export const enterpriseFaq = [
  {
    question: "How does OpenWork help manage shadow AI?",
    answer:
      "OpenWork gives employees an approved path for AI work, with company sign-in, permissions, centrally selected providers, and visibility into routed model usage. It governs traffic configured to use the gateway; it does not automatically discover or block personal accounts and unsanctioned tools outside that path. Pair it with your approved-tool policy and endpoint or network controls where needed."
  },
  {
    question: "Which agents work with the AI gateway?",
    answer:
      "OpenWork and OpenCode with the opencode-openwork plugin can use your organization's AI gateway models. Claude Code, Codex, and Cursor can access shared skills and connections through the MCP gateway. AI gateway model integration for those clients is in progress. Connecting an MCP server alone does not route a client's model traffic."
  },
  {
    question: "Can we use AWS Bedrock and our identity provider?",
    answer:
      "OpenWork supports centrally configured providers including AWS Bedrock, SAML and OIDC single sign-on, and SCIM provisioning and deprovisioning. Confirm your provider configuration, identity setup, permissions, and deployment requirements with the team during an evaluation."
  },
  {
    question: "Does company data leave the employee's computer?",
    answer:
      "In the local desktop model-gateway setup, files and the workspace stay on the employee's computer. Prompts, responses, and file content included as model context travel through the gateway to the selected model provider. Local-first does not mean remote inference never sees company data. Product analytics, diagnostics, update checks, optional cloud workers, and connected services have separate data flows to review."
  },
  {
    question: "How would an enterprise rollout work?",
    answer:
      "Start with a per-user installation and a small pilot group. A proposed 30-day evaluation can cover SSO, provider access, data flows, permissions, and real employee workflows. Use the findings to plan a phased rollout to a few hundred seats if that fits your organization. Timeline, deployment scope, support, and commercial terms are agreed with the team, not guaranteed by this outline."
  },
  {
    question: "Can we self-host or use a managed deployment?",
    answer:
      "OpenWork offers a local-first desktop app, an organizational control plane, and self-hosted deployment options. Discuss managed private deployment requirements with the team, or review the source and deployment documentation. The right setup depends on your infrastructure, identity provider, approved model providers, and operational responsibilities."
  }
];
