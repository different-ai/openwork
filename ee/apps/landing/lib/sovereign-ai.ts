export const SOVEREIGNTY_FRAMEWORK_URL = "https://commission.europa.eu/document/download/09579818-64a6-4dd5-9577-446ab6219113_en";
export const SOVEREIGNTY_FRAMEWORK_NEWS_URL = "https://commission.europa.eu/news-and-media/news/sovereign-cloud-framework-explained-2026-06-01_en";
export const CLOUD_AI_ACT_URL = "https://digital-strategy.ec.europa.eu/en/policies/cloud-and-ai-development-act";

export type SovereigntyHosting = "cloud" | "self";
export type SovereigntyModels = "us" | "eu" | "own";
export type SovereigntySetup = { hosting: SovereigntyHosting; models: SovereigntyModels };

export const sovereigntyHostingOptions: { value: SovereigntyHosting; label: string; detail: string; change: string; needs: string }[] = [
  { value: "cloud", label: "OpenWork Cloud", detail: "We host the control plane and gateway for you.", change: "Use OpenWork Cloud", needs: "OpenWork self-hosted" },
  { value: "self", label: "Self-hosted", detail: "The control plane and gateway run on your own Kubernetes cluster in the EU.", change: "Self-host OpenWork", needs: "OpenWork self-hosted" }
];

export const sovereigntyModelOptions: { value: SovereigntyModels; label: string; detail: string; change: string; needs: string }[] = [
  { value: "us", label: "US provider API", detail: "Prompts go to a model provider's API outside the EU.", change: "Use a US provider's API", needs: "a model outside the EU" },
  { value: "eu", label: "EU cloud region", detail: "Models run in an EU region of a large cloud, such as Amazon Bedrock.", change: "Run models in an EU cloud region", needs: "a model in the EU" },
  { value: "own", label: "Self-served", detail: "Open-weight models on your own hardware in the EU, behind an OpenAI-compatible endpoint.", change: "Serve the models yourself", needs: "a model you serve yourself" }
];

export const sovereigntyDefaultSetup: SovereigntySetup = { hosting: "self", models: "eu" };
/** The setup that answers the most checks. */
export const sovereigntyBestSetup: SovereigntySetup = { hosting: "self", models: "own" };

/** One thing the framework asks of the workspace layer. */
export type SovereigntyCheck = {
  label: string;
  /** Hosting choices that answer the check. Omitted means any. */
  hosting?: SovereigntyHosting[];
  /** Model choices that answer the check. Omitted means any. */
  models?: SovereigntyModels[];
  /** Set when no setup answers the check today: what is open on OpenWork's side. */
  gap?: string;
};

export type SovereigntyObjective = {
  code: string;
  name: string;
  /** Share of the sovereignty score, in percent (Cloud Sovereignty Framework v1.2.1, section 5). */
  weight: number;
  asks: string;
  setBy: string;
  checks: SovereigntyCheck[];
};

const SELF_HOSTED: SovereigntyHosting[] = ["self"];

export const sovereigntyObjectives: SovereigntyObjective[] = [
  {
    code: "SOV-1",
    name: "Strategic",
    weight: 15,
    asks: "Who owns and controls the provider, and whether you can keep running if it pulls out.",
    setBy: "Your cloud provider and each software vendor",
    checks: [
      { label: "Runs on infrastructure you operate.", hosting: SELF_HOSTED },
      { label: "The desktop app is open source, under the MIT licence." },
      { label: "Each release of the control plane and gateway becomes MIT-licensed after two years. That is written into the licence." },
      { label: "A licence change never applies to a version you already run." },
      { label: "A vendor owned and controlled in the EU.", gap: "OpenWork is made by Different AI, Inc., a US company." },
      { label: "Written terms for what happens if the vendor stops.", gap: "Our standard terms do not cover this yet." }
    ]
  },
  {
    code: "SOV-2",
    name: "Legal and jurisdictional",
    weight: 10,
    asks: "Which law governs the provider, and whether an authority outside the EU could compel access to your data.",
    setBy: "Where the service is operated, and by whom",
    checks: [
      { label: "The vendor operates no part of your deployment.", hosting: SELF_HOSTED },
      { label: "Usage logs stay in a database you run.", hosting: SELF_HOSTED },
      { label: "Files stay on the employee's computer." },
      { label: "Product analytics are optional and can be switched off." },
      { label: "A vendor that answers to EU law only.", gap: "Different AI is a US company, so US law applies to us." }
    ]
  },
  {
    code: "SOV-3",
    name: "Data and AI",
    weight: 10,
    asks: "Who holds the keys, who can see data access and model use, where data is processed, and who controls the models.",
    setBy: "Mostly your model and where it runs",
    checks: [
      { label: "You choose the model and the provider." },
      { label: "The gateway's request log records who used which model, not prompt or response bodies." },
      { label: "Organization audit history is available with Enterprise or a self-hosted entitlement, with recording enabled." },
      { label: "Provider keys and sign-in settings are encrypted with a key you hold.", hosting: SELF_HOSTED },
      { label: "Prompts are processed in the EU.", hosting: SELF_HOSTED, models: ["eu", "own"] },
      { label: "The model runs on hardware you control.", models: ["own"] }
    ]
  },
  {
    code: "SOV-4",
    name: "Operational",
    weight: 15,
    asks: "Whether teams in the EU can run, support, and move the technology without a vendor outside the EU.",
    setBy: "Who operates and supports each layer",
    checks: [
      { label: "Your own team installs and upgrades it, from a Helm chart with pinned versions.", hosting: SELF_HOSTED },
      { label: "You choose which desktop versions employees can install." },
      { label: "Deployment guides and source code are public." },
      { label: "Your configuration exports as one file and moves between OpenWork Cloud and self-hosted." },
      { label: "Teams, providers, and connections can be set up from a repeatable script." },
      { label: "Works behind your own certificate authority and proxy." },
      { label: "A diagnostics page shows whether desktops, AI providers, and connectors are working." },
      { label: "Support from a team based in the EU.", gap: "Support comes from the OpenWork team. There is no EU support partner yet." },
      { label: "A long-term support release line.", gap: "Fixes ship on the latest release. There is no long-term support line yet." }
    ]
  },
  {
    code: "SOV-5",
    name: "Supply chain",
    weight: 20,
    asks: "Where hardware and software come from, how software is packaged and updated, and how visible the suppliers are.",
    setBy: "Your hardware, plus every piece of software on it",
    checks: [
      { label: "Every outbound host is published, per component." },
      { label: "A new enterprise install contacts no outside host until you link it to your organization." },
      { label: "Enterprise installs update from their own release channel, never the public one." },
      { label: "Application dependency manifests and lockfiles are public in the source repository." },
      { label: "The model catalog and helper package can come from your own mirror." },
      { label: "The chart and images can be mirrored into your own registry.", hosting: SELF_HOSTED },
      { label: "Desktop installers are served from inside your network.", hosting: SELF_HOSTED },
      { label: "A software bill of materials for each release.", gap: "Not published yet." },
      { label: "Built and distributed on EU-controlled infrastructure.", gap: "Releases are built and distributed through GitHub and npm." },
      { label: "A documented mirror for desktop updates.", gap: "Without internet access you handle desktop updates through your own release process." }
    ]
  },
  {
    code: "SOV-6",
    name: "Technology",
    weight: 15,
    asks: "Open standards and APIs, licences that let you audit and change the software, and a visible architecture.",
    setBy: "Each layer's standards and licence",
    checks: [
      { label: "Open protocols: MCP for tools, SAML and OIDC for sign-in, SCIM for provisioning." },
      { label: "Works with any OpenAI-compatible model endpoint." },
      { label: "All source code is public to read and audit." },
      { label: "The agent engine underneath, OpenCode, is open source." },
      { label: "The architecture and data flows are documented." },
      { label: "Every component under an open-source licence.", gap: "The control plane and gateway are source-available under a commercial licence until each release turns MIT." }
    ]
  },
  {
    code: "SOV-7",
    name: "Security and compliance",
    weight: 10,
    asks: "Certifications, EU rules such as GDPR and NIS2, where security operations sit, and whether you can patch and audit on your own.",
    setBy: "Your security operations and each vendor's audits",
    checks: [
      { label: "SOC 2 Type II and ISO 27001, with reports in the trust center." },
      { label: "Sign-in goes through your identity provider, so your own multi-factor and access rules apply." },
      { label: "A public security policy, with a private reporting address and stated response times." },
      { label: "Logs and monitoring stay in your own tools, through OpenTelemetry.", hosting: SELF_HOSTED },
      { label: "You can read the code and apply a patch yourself.", hosting: SELF_HOSTED },
      { label: "European cloud assurance evidence, such as a C5 attestation.", gap: "Not held yet." }
    ]
  },
  {
    code: "SOV-8",
    name: "Environmental",
    weight: 5,
    asks: "Energy efficiency, hardware reuse, and emissions reporting.",
    setBy: "The data centre you run on",
    checks: [
      { label: "Agents run on computers employees already have." },
      { label: "OpenWork adds no hosting of its own.", hosting: SELF_HOSTED }
    ]
  }
];

export type SovereigntyCheckStatus = "answered" | "setup" | "open";

/** "open" is a gap on OpenWork's side; "setup" is answered by a different hosting or model choice. */
export function sovereigntyCheckStatus(check: SovereigntyCheck, setup: SovereigntySetup): SovereigntyCheckStatus {
  if (check.gap) return "open";
  if (check.hosting && !check.hosting.includes(setup.hosting)) return "setup";
  if (check.models && !check.models.includes(setup.models)) return "setup";
  return "answered";
}

/** What a check that is not answered in this setup needs instead, in words. */
export function sovereigntyCheckNeeds(check: SovereigntyCheck, setup: SovereigntySetup): string {
  const parts: string[] = [];
  if (check.hosting && !check.hosting.includes(setup.hosting)) {
    const option = sovereigntyHostingOptions.find((entry) => entry.value === check.hosting?.[0]);
    if (option) parts.push(option.needs);
  }
  if (check.models && !check.models.includes(setup.models)) {
    const option = sovereigntyModelOptions.find((entry) => entry.value === check.models?.[0]);
    if (option) parts.push(option.needs);
  }
  return parts.join(" and ");
}

export type SovereigntyCoverage = {
  /** Answered checks per objective, weighted as the framework weights its objectives. 0 to 100. */
  percent: number;
  objectives: { code: string; answered: number; total: number }[];
};

/**
 * OpenWork's own count of the workspace checks answered in a setup.
 * It is not a SEAL level or a Sovereignty Score: those are assigned to a whole service by a buyer or an auditor.
 */
export function sovereigntyCoverage(setup: SovereigntySetup): SovereigntyCoverage {
  const objectives = sovereigntyObjectives.map((objective) => ({
    code: objective.code,
    answered: objective.checks.filter((check) => sovereigntyCheckStatus(check, setup) === "answered").length,
    total: objective.checks.length
  }));
  const weighted = sovereigntyObjectives.reduce((sum, objective, index) => sum + (objective.weight * objectives[index].answered) / objectives[index].total, 0);
  const weights = sovereigntyObjectives.reduce((sum, objective) => sum + objective.weight, 0);
  return { percent: Math.round((weighted * 100) / weights), objectives };
}

export const sovereigntyLevels = [
  { code: "SEAL-0", name: "No sovereignty", detail: "Service, technology, and operations under non-EU control and non-EU law." },
  { code: "SEAL-1", name: "Jurisdictional", detail: "EU law applies on paper but is hard to enforce. Operations stay under non-EU control." },
  { code: "SEAL-2", name: "Data", detail: "EU law applies and can be enforced. Material non-EU dependencies remain." },
  { code: "SEAL-3", name: "Digital resilience", detail: "EU actors have real but not full influence. Non-EU control is marginal." },
  { code: "SEAL-4", name: "Full digital sovereignty", detail: "Complete EU control, EU law only, no critical non-EU dependencies." }
];

export const sovereigntySetups = {
  columns: ["EU residency on a large cloud", "Fully in-house"],
  rows: [
    { layer: "Workspace", values: ["OpenWork on your own Kubernetes cluster", "OpenWork on your own Kubernetes cluster"] },
    { layer: "Models", values: ["An EU region of a US cloud provider", "Open-weight models on your own hardware"] },
    { layer: "Sign-in", values: ["A cloud identity provider over SAML", "A self-hosted identity provider over OIDC"] },
    { layer: "Agents run", values: ["On employee computers", "On employee computers"] },
    { layer: "What sets the level", values: ["The cloud provider: its owner and its law", "Your own operations and hardware supply"] }
  ]
};

export const sovereignAiFaq = [
  {
    question: "Which sovereignty level is OpenWork?",
    answer: "None, and no software vendor can honestly give you one. Levels in the Cloud Sovereignty Framework are assigned by the buyer or an auditor to a whole service: the infrastructure, the operator, the models, and the software together. This page counts what OpenWork answers on each objective in the setup you pick and lists what is still open, so you can fill in your own assessment."
  },
  {
    question: "What does the percentage on this page mean?",
    answer: "It is our own checklist, not the Commission's scoring method. We group workspace checks under the framework's eight objectives. Checks have equal weight within each objective; the objectives use the framework's published weights. The percentage counts documented capabilities for the setup you pick, not a verification of your deployment. It is not a SEAL level or a Sovereignty Score. Your hardware, data centre, and model provider need a separate assessment; one critical gap can still rule out a service."
  },
  {
    question: "Is this the EU AI Act?",
    answer: "No. The EU AI Act regulates how AI systems are built and used. The Cloud Sovereignty Framework and the proposed Cloud and AI Development Act are about who controls the cloud and AI services you buy. An organization can be subject to both."
  },
  {
    question: "Can OpenWork run without contacting OpenWork's servers?",
    answer: "Self-hosted, the control plane and gateway run in your environment. By default the desktop app still fetches a model catalog, updates, and one helper package from public hosts; each can be mirrored. The air-gapped deployment guide lists what a fully isolated setup has to mirror, disable, or replace, including the parts that are not documented yet."
  },
  {
    question: "Which models can we use?",
    answer: "The ones you approve. The gateway supports major providers, including Amazon Bedrock in a region you choose, and OpenAI-compatible endpoints, which covers models you serve on your own hardware. Model choice decides most of the data and AI objective, so pick it before you pick a workspace."
  },
  {
    question: "Is OpenWork open source?",
    answer: "The desktop app is MIT-licensed. The control plane and gateway are source-available under the OpenWork Enterprise Edition licence: you can read and modify the code. Production use needs a subscription, except for organizations with up to five users excluding Enterprise Features. Evaluation, development, and testing exceptions also apply. Each EE release becomes MIT-licensed after two years."
  }
];
