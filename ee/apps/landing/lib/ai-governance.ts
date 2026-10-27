export const aiGovernanceFaq = [
  { question: "What is AI governance?", answer: "AI governance is the set of owners, policies, reviews, and technical controls that determines how an organization uses AI. For employee tools, it covers approved providers, permitted data, access, human review, usage visibility, and incident handling. It is an ongoing operating practice, not a certification or a single product." },
  { question: "What does an AI governance platform do?", answer: "An AI governance platform can centralize parts of the operating model, such as identity, permissions, approved model providers, and usage records. Evaluate the scope of each product: model access controls are different from network-wide discovery, data-loss prevention, model-risk assessments, and regulatory reporting. OpenWork focuses on governed access for supported agents and model traffic routed through its gateway." },
  { question: "How is enterprise AI governance different from an AI usage policy?", answer: "The AI usage policy records what is allowed and who is accountable. Enterprise AI governance makes that policy operational through onboarding, provider review, access controls, employee training, exception handling, and recurring reviews. Both need named owners and an escalation path." },
  { question: "How can we provide secure AI for employees?", answer: "Start by reviewing the work employees want to do and the data involved. Offer approved providers and tools, company sign-in, least-privilege access, clear data rules, and output review. Test the data flows, access removal, and incident process in a pilot. No platform can guarantee security independently of its configuration, providers, and employee practices." },
  { question: "Does local-first mean no company data reaches a model?", answer: "No. The local desktop keeps files and workspace processing on the user's PC, but prompts and file context supplied to a remote model leave the device. In the model-gateway setup, workspace processing sends SSO configuration and model traffic rather than a workspace copy. Analytics, diagnostics, updates, connected services, and optional cloud workers have separate data flows." },
  { question: "Is an AI gateway a complete enterprise AI governance solution?", answer: "No. A gateway can control supported model traffic routed through it. Pair it with a policy, provider and legal review, training, access reviews, and endpoint or network controls where needed. OpenWork does not automatically discover or block every AI tool outside the approved path." }
];

export const aiGovernanceMarkdown = `# AI governance: a practical framework for employee AI

AI governance defines who can use AI, with which data, through which tools and providers, and under whose accountability. An AI governance platform supports the operating model; it does not replace it.

## Four steps

1. Discover tools and use cases, including shadow AI. Assign an owner and classify the data.
2. Set an AI usage policy: approved providers, prohibited data, human review, exceptions, and incident handling.
3. Provide a sanctioned path with company SSO, permissions, approved models, and onboarding.
4. Monitor routed usage, review access and exceptions, and update the policy.

## Evaluate the platform, not the promise

Test identity and offboarding, model permissions, provider choice including AWS Bedrock, routed usage visibility, supported clients, and the local-first data boundary. OpenWork and OpenCode with the OpenWork plugin support company AI gateway models. Claude Code, Codex, and Cursor use the MCP gateway for skills and connections; their AI gateway model integration is in progress. Adding MCP does not route model traffic. OpenWork does not automatically detect every unsanctioned AI tool.

## FAQ

${aiGovernanceFaq.map(({question, answer}) => `### ${question}\n\n${answer}`).join("\n\n")}

## Next steps

- [Manage shadow AI](https://openworklabs.com/shadow-ai)
- [Enterprise deployment and demo](https://openworklabs.com/enterprise)
- [Privacy](https://openworklabs.com/privacy)
`;
