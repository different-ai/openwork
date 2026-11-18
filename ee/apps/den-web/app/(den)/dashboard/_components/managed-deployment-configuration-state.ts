import {
  assistantsEnabled, awsManagedDeploymentInputSchema, planDeploymentConfigurationChange,
  type AwsManagedDeploymentInput, type DeploymentConfiguration, type DeploymentConfigurationChange, type DeploymentConfigurationField,
  type DeploymentConfigurationPlan, type ManagedDeployment,
} from "@openwork/types/den/managed-deployments";

export type AwsDeployment = Extract<ManagedDeployment, { provider: "aws" }>;
export type ConfigurationView = NonNullable<AwsDeployment["configuration"]>;
export type ConfigurationChangeView = NonNullable<ConfigurationView["change"]>;
/** An AWS deployment whose view says what may change now. */
export type EditableDeployment = AwsDeployment & { configuration: ConfigurationView };
export type ConfigurationEntry = { shown: boolean; disabled: boolean; reason: string | null };

export const GATEWAY_RUNTIME_NOT_ENABLED = "The gateway runtime isn't enabled for this workspace. Ask your OpenWork operator.";
const LOCK_REASONS: Record<NonNullable<ConfigurationView["lock"]>, string> = {
  aws_only: "Google Cloud deployments can't be edited after installation yet.",
  not_installed: "Available after installation. To change a deployment that isn't installed yet, remove it and create it again.",
  run_in_progress: "An install, update or change is waiting for approval or running in AWS. Finish it first.",
  unfinished_run: "The last install, retry or update didn't finish. Finish it with Retry or Update, then edit the configuration.",
  installer_unknown: "OpenWork can't tell which installer this deployment runs. Update the deployment, then edit the configuration.",
  installer_unavailable: "This deployment's installer can no longer be run as it was installed. Update the deployment, then edit the configuration.",
};

export function hasConfiguration(deployment: ManagedDeployment): deployment is EditableDeployment {
  return deployment.provider === "aws" && deployment.configuration !== undefined;
}

/**
 * The "Edit configuration" control. Hidden only when the feature is off for
 * this person; otherwise it stays visible and a lock says why it can't be used.
 * Someone without permission gets no reason here: the page states it once.
 */
export function configurationEntry(deployment: ManagedDeployment, options: { enabled: boolean; canManage: boolean }): ConfigurationEntry {
  if (!options.enabled || !deployment.configuration) return { shown: false, disabled: true, reason: null };
  if (!options.canManage) return { shown: true, disabled: true, reason: null };
  const lock = deployment.provider === "aws" ? deployment.configuration.lock : "aws_only";
  return { shown: true, disabled: lock !== null, reason: lock ? LOCK_REASONS[lock] : null };
}

/** What the deployment records now: the "before" of every change. */
export function recordedConfiguration(deployment: AwsDeployment): DeploymentConfiguration {
  return { name: deployment.name, domainName: deployment.domainName, ownerEmail: deployment.ownerEmail, size: deployment.size, target: deployment.target };
}

/** The recorded configuration as a request. Sent as is, it withdraws a pending change. */
export function recordedDocument(deployment: AwsDeployment): AwsManagedDeploymentInput {
  return { provider: "aws", ...recordedConfiguration(deployment) };
}

/**
 * What the dialog opens with: the request already made when a change is
 * pending, failed or expired, otherwise the recorded configuration. A rename is
 * saved at once, so the name always comes from the deployment.
 */
export function configurationDraft(deployment: AwsDeployment): AwsManagedDeploymentInput {
  const requested = deployment.configuration?.change?.requested;
  return requested ? { ...requested, name: deployment.name } : recordedDocument(deployment);
}

export type DraftPlan =
  | { ok: true; configuration: AwsManagedDeploymentInput; plan: Extract<DeploymentConfigurationPlan, { ok: true }> }
  | { ok: false; message: string; field: DeploymentConfigurationField | null };

/** The draft as the API will read it. Every rule about what may change is the shared plan's. */
export function planConfigurationDraft(deployment: AwsDeployment, draft: AwsManagedDeploymentInput): DraftPlan {
  const parsed = awsManagedDeploymentInputSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "name") return { ok: false, field: "name", message: "Enter a name of up to 80 characters." };
    if (issue?.path[0] === "ownerEmail") return { ok: false, field: "ownerEmail", message: "Enter the first administrator's email address." };
    return { ok: false, field: null, message: issue?.message ?? "Check the configuration and try again." };
  }
  const plan = planDeploymentConfigurationChange(recordedConfiguration(deployment), parsed.data);
  if (!plan.ok) return { ok: false, field: plan.rejection.field, message: plan.rejection.message };
  return { ok: true, configuration: parsed.data, plan };
}

/** Why "Add gateway runtime" can't be used on this deployment, or null. */
export function gatewayLockReason(deployment: EditableDeployment, assistantsAvailable: boolean): string | null {
  if (!assistantsAvailable) return GATEWAY_RUNTIME_NOT_ENABLED;
  if (deployment.configuration.gatewayAvailable) return null;
  return deployment.updateAvailable && deployment.availableVersion
    ? `Turn this on with Update to ${deployment.availableVersion}.`
    : "This deployment's installer isn't the published one. Ask your OpenWork operator.";
}

/** Why an otherwise valid plan can't be sent from this workspace, or null. */
export function planLockReason(deployment: EditableDeployment, plan: Extract<DeploymentConfigurationPlan, { ok: true }>, assistantsAvailable: boolean): string | null {
  if (plan.needsAssistantsFeature && !assistantsAvailable) return GATEWAY_RUNTIME_NOT_ENABLED;
  return plan.enablesGateway ? gatewayLockReason(deployment, assistantsAvailable) : null;
}

/**
 * The lock line of the detail's "Managed runtime" block. Once Edit
 * configuration can be used, "wait for a newer installer" is no longer true.
 */
export function runtimeLockReason(deployment: ManagedDeployment, reason: string | null, entry: ConfigurationEntry, assistantsAvailable: boolean): string | null {
  if (!reason || !entry.shown || entry.disabled || !assistantsAvailable) return reason;
  const run = deployment.run;
  if (run && !run.expired && (run.state === "awaiting_approval" || run.state === "provisioning")) return reason;
  return "Use Edit configuration to change the runtime profile or computers.";
}

const FIELD_LABELS: Record<DeploymentConfigurationField, string> = {
  name: "Name",
  domainName: "Address",
  ownerEmail: "First administrator email",
  "target.accountId": "AWS account",
  "target.region": "Region",
  "target.route53ZoneId": "Hosted zone",
  "target.network": "Network",
  "target.runtimeProfile": "Runtime",
  "target.assistants.headlessRunnerEnabled": "Managed runner",
  "target.assistants.workbotEnabled": "Workbot",
  "target.assistants.slackAssistantEnabled": "Slack and Automations",
  "target.assistants.modelProtocol": "Model protocol",
  "target.assistants.modelBaseUrl": "Model HTTPS endpoint",
  "target.assistants.model": "Model ID",
  "target.assistants.modelSecretArn": "Model key secret ARN",
  "target.assistants.computerProvider": "Cloud computers",
  "target.assistants.computerSecretArn": "Computer provider key secret ARN",
  "target.assistants.computerSnapshot": "Daytona computer snapshot",
  "target.assistants.daytonaApiUrl": "Daytona HTTPS API endpoint",
  "target.assistants.daytonaTarget": "Daytona target",
};

export function fieldLabel(field: DeploymentConfigurationField): string {
  return FIELD_LABELS[field];
}

/** How the runtime a deployment has is named. */
export function runtimeLabel(target: AwsDeployment["target"]): string {
  if (target.runtimeProfile === "gateway") return "Gateway runtime";
  return assistantsEnabled(target.assistants) ? "Core services and its own runner" : "Core services only";
}

const COMPUTER_PROVIDERS: Record<string, string> = { off: "Off", daytona: "Daytona", freestyle: "Freestyle" };

/** A changed value as a person reads it. Secret ARNs are references and are shown whole. */
export function valueLabel(field: DeploymentConfigurationField, value: string | null, deployment?: AwsDeployment): string {
  if (value === null || value === "") return "Not set";
  if (field === "target.runtimeProfile") return value === "gateway" ? "Gateway runtime" : deployment ? runtimeLabel({ ...deployment.target, runtimeProfile: "legacy" }) : "Core services only";
  if (field === "target.assistants.computerProvider") return COMPUTER_PROVIDERS[value] ?? value;
  if (value === "true") return "On";
  if (value === "false") return "Off";
  return value;
}

function networkLabel(network: AwsDeployment["target"]["network"]): string {
  if (network.mode === "dedicated") return "Dedicated VPC";
  const cluster = network.ecsClusterArn?.split("/").pop();
  return cluster ? `${network.vpcId} · cluster ${cluster}` : network.vpcId;
}

/** The values chosen at installation, which no change can touch. */
export function fixedConfigurationRows(deployment: AwsDeployment): { field: string; label: string; value: string }[] {
  return [
    { field: "domainName", label: FIELD_LABELS.domainName, value: deployment.domainName },
    { field: "target.accountId", label: FIELD_LABELS["target.accountId"], value: deployment.target.accountId },
    { field: "target.region", label: FIELD_LABELS["target.region"], value: deployment.target.region },
    { field: "target.route53ZoneId", label: FIELD_LABELS["target.route53ZoneId"], value: deployment.target.route53ZoneId },
    { field: "target.network", label: FIELD_LABELS["target.network"], value: networkLabel(deployment.target.network) },
    { field: "size", label: "Size", value: "Small" },
  ];
}

export type ChangeGroup = { effect: DeploymentConfigurationChange["effect"]; changes: DeploymentConfigurationChange[]; sentence: string };

function effectSentence(group: Pick<ChangeGroup, "effect" | "changes">, deployment: AwsDeployment, all: DeploymentConfigurationChange[]): string {
  switch (group.effect) {
    case "saved_immediately": return "Saved now. Nothing changes in AWS.";
    case "restarts_den": return `${group.changes.some((change) => change.field === "ownerEmail")
      ? `Changes who can complete first sign-in at ${deployment.domainName}/setup. An administrator who has already signed in stays the administrator. ` : ""}The OpenWork API and web app restart.`;
    case "restarts_runner": return all.some((change) => change.effect === "adds_gateway_runtime")
      ? "Starts with the gateway runtime's managed runner."
      : "The managed runner stops and starts again; work it is running at that moment is interrupted.";
    case "adds_gateway_runtime": return "Adds the model gateway, managed runner, Workbot, Slack and Automations, file storage and daily backups. They can't be removed later.";
  }
}

/** Changes that do the same thing to the installation, in order, with what that is said once. */
export function changeGroups(deployment: AwsDeployment, changes: DeploymentConfigurationChange[]): ChangeGroup[] {
  const groups: Pick<ChangeGroup, "effect" | "changes">[] = [];
  for (const change of changes) {
    const last = groups.at(-1);
    if (last && last.effect === change.effect) last.changes.push(change);
    else groups.push({ effect: change.effect, changes: [change] });
  }
  return groups.map((group) => ({ ...group, sentence: effectSentence(group, deployment, changes) }));
}

/** One sentence naming the action, where it happens, what restarts or is billed, and what OpenWork sees. */
export function consentSentence(deployment: AwsDeployment, changes: DeploymentConfigurationChange[]): string {
  const has = (effect: DeploymentConfigurationChange["effect"]) => changes.some((change) => change.effect === effect);
  const provider = changes.find((change) => change.field === "target.assistants.computerProvider")?.after ?? deployment.target.assistants.computerProvider;
  const computers = COMPUTER_PROVIDERS[provider] ?? provider;
  const consequences = [
    ...(has("restarts_den") || has("adds_gateway_runtime") ? ["the OpenWork API and web app restart"] : []),
    ...(has("restarts_runner") && !has("adds_gateway_runtime") ? ["the managed runner restarts"] : []),
    ...(has("adds_gateway_runtime") ? ["AWS adds and bills the gateway runtime's services, storage and backups, which can't be removed later"] : []),
    ...(provider !== "off" && (has("restarts_runner") || has("adds_gateway_runtime")) ? [`${computers} computers run outside my AWS account and are billed by ${computers}`] : []),
  ].join("; ");
  return `I'll approve this in AWS account ${deployment.target.accountId} by running one command in AWS CloudShell; nothing changes until I do.${
    consequences ? ` ${consequences.charAt(0).toUpperCase()}${consequences.slice(1)}.` : ""} OpenWork receives progress and health checks, never secret values.`;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What is true of a requested change right now. */
export function changeStateLine(change: Pick<ConfigurationChangeView, "state" | "requestedAt" | "expiresAt">, time: (iso: string) => string = clockTime): string {
  switch (change.state) {
    case "awaiting_approval": return `Nothing has changed yet. The approval expires at ${time(change.expiresAt)}.`;
    case "applying": return "AWS is applying this now. The deployment shows the new values when it finishes.";
    case "failed": return "AWS may be partly changed. OpenWork still shows the values from before this change.";
    case "expired": {
      const hours = Math.max(1, Math.round((Date.parse(change.expiresAt) - Date.parse(change.requestedAt)) / 3_600_000));
      return `Not approved within ${hours} ${hours === 1 ? "hour" : "hours"}. Nothing changed.`;
    }
  }
}
