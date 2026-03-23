export type FeedbackTemplateContext = {
  source?: string;
  entrypoint?: string;
  deployment?: string;
  appVersion?: string;
  openworkServerVersion?: string;
  opencodeVersion?: string;
  orchestratorVersion?: string;
  opencodeRouterVersion?: string;
  osName?: string;
  osVersion?: string;
  platform?: string;
};

type BuildFeedbackEmailVariablesInput = {
  name: string;
  email: string;
  message: string;
  submittedAt: string;
  context: FeedbackTemplateContext;
};

function buildSummary(
  items: Array<{ label: string; value: string | undefined }>,
): string {
  return items
    .filter((item) => item.value)
    .map((item) => `${item.label}: ${item.value}`)
    .join("\n");
}

function joinSummarySections(sections: string[]): string {
  return sections.filter(Boolean).join("\n\n");
}

function formatSubmittedAtDisplay(submittedAt: string): string {
  const date = new Date(submittedAt);

  if (Number.isNaN(date.getTime())) {
    return submittedAt;
  }

  return `${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function buildFeedbackEmailVariables(
  input: BuildFeedbackEmailVariablesInput,
) {
  const osLabel = [input.context.osName, input.context.osVersion]
    .filter(Boolean)
    .join(" ");

  const environmentSummary = joinSummarySections([
    buildSummary([
      { label: "App version", value: input.context.appVersion },
      { label: "Platform", value: input.context.platform },
      { label: "OS", value: osLabel },
    ]),
    buildSummary([
      { label: "OpenWork server", value: input.context.openworkServerVersion },
      { label: "OpenCode", value: input.context.opencodeVersion },
      { label: "Orchestrator", value: input.context.orchestratorVersion },
      { label: "Router", value: input.context.opencodeRouterVersion },
    ]),
  ]);

  const contextSummary = buildSummary([
    { label: "Source", value: input.context.source },
    { label: "Entrypoint", value: input.context.entrypoint },
    { label: "Deployment", value: input.context.deployment },
  ]);

  const submittedAtDisplay = formatSubmittedAtDisplay(input.submittedAt);
  const senderLine = `${input.name} <${input.email}>`;
  const plainTextBody = [
    "OpenWork App Feedback",
    `From: ${senderLine}`,
    `Submitted: ${submittedAtDisplay}`,
    "",
    "ISSUE",
    input.message,
    "",
    "APP + ENVIRONMENT",
    environmentSummary,
    "",
    "CONTEXT",
    contextSummary,
  ].join("\n");

  return {
    senderLine,
    submittedAtDisplay,
    osLabel,
    environmentSummary,
    contextSummary,
    plainTextBody,
  };
}
