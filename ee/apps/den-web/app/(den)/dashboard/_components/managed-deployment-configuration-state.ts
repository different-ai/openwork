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
 * `permissionReason` is the page's sentence for someone who may not manage
 * deployments, repeated beside the control because the page is long.
 */
export function configurationEntry(deployment: ManagedDeployment, options: { enabled: boolean; canManage: boolean; permissionReason?: string }): ConfigurationEntry {
  if (!options.enabled || !deployment.configuration) return { shown: false, disabled: true, reason: null };
  if (!options.canManage) return { shown: true, disabled: true, reason: options.permissionReason ?? null };
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
  /** `incomplete`: a value the draft needs is still empty, so the message says what to enter and nothing has gone wrong. */
  | { ok: false; message: string; field: DeploymentConfigurationField | null; incomplete: boolean };

/** A value the draft cannot be sent without has not been entered yet. */
function draftIncomplete(draft: AwsManagedDeploymentInput): boolean {
  const computers = draft.target.assistants;
  const provider = computers?.computerProvider ?? "off";
  return !draft.name.trim() || !draft.ownerEmail.trim()
    || (provider !== "off" && (!computers?.computerSecretArn || (provider === "daytona" && !computers.computerSnapshot)));
}

/** The draft as the API will read it. Every rule about what may change is the shared plan's. */
export function planConfigurationDraft(deployment: AwsDeployment, draft: AwsManagedDeploymentInput): DraftPlan {
  const incomplete = draftIncomplete(draft);
  const parsed = awsManagedDeploymentInputSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "name") return { ok: false, field: "name", incomplete, message: "Enter a name of up to 80 characters." };
    if (issue?.path[0] === "ownerEmail") return { ok: false, field: "ownerEmail", incomplete, message: "Enter the first administrator's email address." };
    return { ok: false, field: null, incomplete, message: issue?.message ?? "Check the configuration and try again." };
  }
  const plan = planDeploymentConfigurationChange(recordedConfiguration(deployment), parsed.data);
  if (!plan.ok) return { ok: false, field: plan.rejection.field, incomplete, message: plan.rejection.message };
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

export type RuntimeBlock = {
  /** The lock line of the block, or null. */
  reason: string | null;
  /** Edit configuration is where this deployment's runtime changes: the block points there and offers no Update control of its own. */
  viaConfiguration: boolean;
};

/**
 * The detail's "Managed runtime" block. Once Edit configuration can be used,
 * "wait for a newer installer" is no longer true and the block points there.
 */
export function runtimeBlock(deployment: ManagedDeployment, reason: string | null, entry: ConfigurationEntry, assistantsAvailable: boolean): RuntimeBlock {
  if (!reason || !entry.shown || entry.disabled || !assistantsAvailable) return { reason, viaConfiguration: false };
  const run = deployment.run;
  if (run && !run.expired && (run.state === "awaiting_approval" || run.state === "provisioning")) return { reason, viaConfiguration: false };
  // The core-services block says where the gateway runtime is added; a gateway deployment's computers are all that is left to change.
  const gateway = deployment.provider === "aws" && deployment.target.runtimeProfile === "gateway";
  return { reason: gateway ? "Use Edit configuration to change cloud computers." : null, viaConfiguration: true };
}

type Run = NonNullable<ManagedDeployment["run"]>;

/** A change whose approval ran out before anyone approved it: nothing started, so there is no progress to show. */
export function changeNeverApproved(run: Pick<Run, "kind" | "state" | "expired">): boolean {
  return run.kind === "configure" && run.state === "awaiting_approval" && run.expired;
}

/**
 * The approval handoff the page is holding, while it is still the one to act
 * on: issued for the deployment's active run, which is still awaiting approval.
 * A change someone replaced or withdrew, or one whose approval ran out, has
 * no command to show.
 */
export function currentHandoff<Handoff extends { deployment: Pick<ManagedDeployment, "id" | "run"> }>(handoff: Handoff | null, deployment: Pick<ManagedDeployment, "id" | "run">): Handoff | null {
  const run = deployment.run;
  if (!handoff || !run || handoff.deployment.id !== deployment.id || handoff.deployment.run?.id !== run.id) return null;
  return run.state === "awaiting_approval" && !run.expired ? handoff : null;
}

// What to do after each installer failure when the run was a configuration change: the next step is the change itself, not Retry.
const CHANGE_FAILURES: Record<string, string> = {
  release_verification_failed: "The release could not be verified. Open the installer logs in AWS.",
  infrastructure_failed: "AWS could not apply the change. Open the installer logs in AWS, then review the change and try again.",
  certificate_failed: "AWS could not issue the HTTPS certificate. Make sure the domain's CAA records allow amazon.com, then review the change and try again.",
  service_unhealthy: "Services did not start. Check the ECS service events in AWS, then review the change and try again.",
  health_check_failed: "HTTPS or the database could not be verified. Check DNS for the domain, then review the change and try again.",
  network_check_failed: "The existing network can't host this change. The installer logs in AWS CodeBuild say what to change (subnets, routes, DNS or the ECS cluster); fix it, then review the change and try again.",
  runner_failed: "The AWS account or hosted zone did not match. Check the deployment details.",
};

/** A change that reached AWS and then went quiet until its time ran out. */
export const CHANGE_STOPPED_REPORTING = "The installer stopped reporting. Open the installer logs in AWS, then review the change and try again.";

/** Why a configuration change's run failed and what to do next, or null for a code this screen has no sentence for. */
export function changeFailureMessage(errorCode: string): string | null {
  return CHANGE_FAILURES[errorCode] ?? null;
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

const SERVICES_RESTART = "The OpenWork API and web app restart.";

/**
 * What a group of changes does to the running installation. Every approved run
 * restarts the OpenWork API and web app, whatever changed; `first` is the group
 * that says so, so it is said once.
 */
function effectSentence(group: Pick<ChangeGroup, "effect" | "changes">, deployment: AwsDeployment, all: DeploymentConfigurationChange[], first: boolean): string {
  const restart = first ? ` ${SERVICES_RESTART}` : "";
  switch (group.effect) {
    case "saved_immediately": return "Saved now. Nothing changes in AWS.";
    case "restarts_den": return `${group.changes.some((change) => change.field === "ownerEmail")
      ? `Changes who can complete first sign-in at ${deployment.domainName}/setup. An administrator who has already signed in stays the administrator.` : ""}${restart}`.trim();
    case "restarts_runner": {
      if (all.some((change) => change.effect === "adds_gateway_runtime")) return `Starts with the gateway runtime's managed runner.${restart}`;
      return first ? `${SERVICES_RESTART} The managed runner stops and starts again; work it is running at that moment is interrupted.`
        : "The managed runner also stops and starts again; work it is running at that moment is interrupted.";
    }
    case "adds_gateway_runtime": return `Adds the model gateway, managed runner, Workbot, Slack and Automations, file storage and daily backups. They can't be removed later.${restart}`;
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
  const first = groups.find((group) => group.effect !== "saved_immediately");
  return groups.map((group) => ({ ...group, sentence: effectSentence(group, deployment, changes, group === first) }));
}

/** One sentence naming the action, where it happens, what restarts or is billed, and what OpenWork sees. */
export function consentSentence(deployment: AwsDeployment, changes: DeploymentConfigurationChange[]): string {
  const has = (effect: DeploymentConfigurationChange["effect"]) => changes.some((change) => change.effect === effect);
  const provider = changes.find((change) => change.field === "target.assistants.computerProvider")?.after ?? deployment.target.assistants.computerProvider;
  const computers = COMPUTER_PROVIDERS[provider] ?? provider;
  const consequences = [
    // Every approved run redeploys both, whatever it changes.
    ...(changes.some((change) => change.effect !== "saved_immediately") ? ["the OpenWork API and web app restart"] : []),
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
