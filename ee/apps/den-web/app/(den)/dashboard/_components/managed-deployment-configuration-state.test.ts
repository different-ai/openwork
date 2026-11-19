import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentConfigurationLockSchema, gatewayAssistants, managedDeploymentSchema, type DeploymentConfigurationChange } from "@openwork/types/den/managed-deployments";
import {
  CHANGE_STOPPED_REPORTING, changeFailureMessage, changeGroups, changeNeverApproved, changeStateLine, configurationDraft, configurationEntry, consentSentence, currentHandoff, fixedConfigurationRows,
  gatewayLockReason, hasConfiguration, planConfigurationDraft, planLockReason, recordedDocument, runtimeBlock, valueLabel, type EditableDeployment,
} from "./managed-deployment-configuration-state";
import { assistantSettingsState } from "./managed-deployments-state";

const REVISION = "a".repeat(64);
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd";
const DAYTONA = { computerProvider: "daytona", computerSecretArn: SECRET_ARN, computerSnapshot: "computer-snapshot" };
const OWN_RUNNER = {
  headlessRunnerEnabled: true, workbotEnabled: true, slackAssistantEnabled: false, modelProtocol: "anthropic", modelBaseUrl: "https://model.example.com/v1",
  model: "example-model", modelSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/model-Ef34Gh",
};
const TIMES = { requestedAt: "2026-10-01T11:05:00.000Z", expiresAt: "2026-10-01T14:05:00.000Z" };

type Fixture = { provider?: "aws" | "gcp"; target?: Record<string, unknown>; configuration?: Record<string, unknown> | null; view?: Record<string, unknown> };

function view({ provider = "aws", target = {}, configuration = {}, view: overrides = {} }: Fixture = {}) {
  return managedDeploymentSchema.parse({
    id: "00000000-0000-4000-8000-000000000001", name: "Production", provider,
    target: provider === "aws" ? { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST", ...target }
      : { projectId: "openwork-test", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "example-com" },
    domainName: "openwork.example.com", ownerEmail: "admin@example.com", size: "small", updateMode: "approval",
    createdAt: "2026-10-01T00:00:00.000Z", webUrl: "https://openwork.example.com", consoleUrl: "https://console.example.com",
    installedVersion: "1.2.2", availableVersion: "1.2.2", updateAvailable: false,
    health: { state: "operational", reportedAt: "2026-10-01T00:00:00.000Z", version: "1.2.2", checks: [] },
    run: null,
    ...(configuration ? { configuration: { revision: REVISION, lock: null, gatewayAvailable: true, change: null, ...configuration } } : {}),
    ...overrides,
  });
}

function editable(fixture: Fixture = {}): EditableDeployment {
  const deployment = view(fixture);
  if (!hasConfiguration(deployment)) throw new Error("Fixture is not an editable AWS deployment");
  return deployment;
}

function pendingChange(state: string, requested: Record<string, unknown>, changes: DeploymentConfigurationChange[]) {
  return { runId: "00000000-0000-4000-8000-000000000002", state, ...TIMES, changes, requested };
}

function accepted(deployment: EditableDeployment, draft: Parameters<typeof planConfigurationDraft>[1]) {
  const planned = planConfigurationDraft(deployment, draft);
  if (!planned.ok) throw new Error(`Refused: ${planned.message}`);
  return planned;
}

const EMAIL_CHANGE: DeploymentConfigurationChange = { field: "ownerEmail", before: "admin@example.com", after: "owner@example.com", effect: "restarts_den" };

test("Edit configuration is hidden only when the feature is off, and otherwise says why it is locked", () => {
  const on = { enabled: true, canManage: true };
  assert.deepEqual(configurationEntry(view(), on), { shown: true, disabled: false, reason: null });
  assert.equal(configurationEntry(view(), { enabled: false, canManage: true }).shown, false, "the dashboard flag is off");
  assert.equal(configurationEntry(view({ configuration: null }), on).shown, false, "the API did not offer configuration changes to this person");
  const permission = "Needs the “Manage deployments” permission. Ask the organization owner.";
  assert.deepEqual(configurationEntry(view(), { enabled: true, canManage: false, permissionReason: permission }), { shown: true, disabled: true, reason: permission }, "the control says why it is locked and who can change that");
  assert.deepEqual(configurationEntry(view({ configuration: { lock: "unfinished_run" } }), { enabled: true, canManage: false, permissionReason: permission }).reason, permission, "the missing permission comes before any other lock");
  assert.equal(configurationEntry(view(), { enabled: true, canManage: true, permissionReason: permission }).reason, null);

  const cloud = configurationEntry(view({ provider: "gcp", configuration: { lock: "aws_only" } }), on);
  assert.equal(cloud.disabled, true);
  assert.equal(cloud.reason, "Google Cloud deployments can't be edited after installation yet.");

  const reasons = deploymentConfigurationLockSchema.options.map((lock) => {
    const entry = configurationEntry(view({ configuration: { lock } }), on);
    assert.deepEqual([entry.shown, entry.disabled], [true, true], lock);
    return entry.reason ?? "";
  });
  assert.equal(new Set(reasons).size, reasons.length, "every lock has its own sentence");
  for (const reason of reasons) assert.match(reason, /\.$/);
  assert.match(configurationEntry(view({ configuration: { lock: "not_installed" } }), on).reason ?? "", /^Available after installation\./);
  assert.match(configurationEntry(view({ configuration: { lock: "unfinished_run" } }), on).reason ?? "", /Finish it with Retry or Update/);
});

test("a change awaiting approval can still be edited; one that AWS is applying cannot", () => {
  const requested = { ...recordedDocument(editable()), ownerEmail: "owner@example.com" };
  const awaiting = view({ configuration: { change: pendingChange("awaiting_approval", requested, [EMAIL_CHANGE]) } });
  assert.deepEqual(configurationEntry(awaiting, { enabled: true, canManage: true }), { shown: true, disabled: false, reason: null });
  const applying = view({ configuration: { lock: "run_in_progress", change: pendingChange("applying", requested, [EMAIL_CHANGE]) } });
  assert.deepEqual(configurationEntry(applying, { enabled: true, canManage: true }), {
    shown: true, disabled: true, reason: "An install, update or change is waiting for approval or running in AWS. Finish it first.",
  });
});

test("the draft is the whole recorded configuration, so sending it back changes nothing", () => {
  for (const target of [{}, { assistants: OWN_RUNNER }, { runtimeProfile: "gateway" }, { runtimeProfile: "gateway", assistants: DAYTONA }]) {
    const deployment = editable({ target });
    const draft = configurationDraft(deployment);
    assert.deepEqual(draft, { provider: "aws", name: "Production", domainName: "openwork.example.com", ownerEmail: "admin@example.com", size: "small", target: deployment.target });
    assert.deepEqual(draft.target.assistants, deployment.target.assistants, "every assistant setting is carried, not a default");
    assert.deepEqual(accepted(deployment, draft).plan.changes, []);
  }
});

test("the draft of a pending, failed or expired change is what was requested, under the current name", () => {
  const recorded = recordedDocument(editable());
  const requested = { ...recorded, name: "Old name", ownerEmail: "owner@example.com", target: { ...recorded.target, runtimeProfile: "gateway", assistants: DAYTONA } };
  for (const state of ["awaiting_approval", "failed", "expired"]) {
    const deployment = editable({ configuration: { change: pendingChange(state, requested, [EMAIL_CHANGE]) } });
    const draft = configurationDraft(deployment);
    assert.equal(draft.name, "Production", "a rename is saved at once, so it is never part of a pending change");
    assert.equal(draft.ownerEmail, "owner@example.com");
    assert.equal(draft.target.runtimeProfile, "gateway");
    assert.equal(draft.target.assistants.computerProvider, "daytona");
    assert.deepEqual(accepted(deployment, draft).plan.changes.map((change) => change.field), [
      "ownerEmail", "target.runtimeProfile", "target.assistants.computerProvider", "target.assistants.computerSecretArn", "target.assistants.computerSnapshot",
    ]);
    assert.deepEqual(recordedDocument(deployment), recorded, "discarding sends the recorded configuration");
  }
});

test("a draft is planned as the API will read it, and refusals are sentences a person can act on", () => {
  const deployment = editable();
  const draft = configurationDraft(deployment);
  const renamed = accepted(deployment, { ...draft, name: "  Production EU " });
  assert.deepEqual(renamed.plan.changes, [{ field: "name", before: "Production", after: "Production EU", effect: "saved_immediately" }]);
  assert.equal(renamed.configuration.name, "Production EU");
  assert.equal(renamed.plan.requiresApproval, false);

  assert.deepEqual(planConfigurationDraft(deployment, { ...draft, name: "   " }), { ok: false, field: "name", incomplete: true, message: "Enter a name of up to 80 characters." });
  assert.deepEqual(planConfigurationDraft(deployment, { ...draft, name: "x".repeat(81) }), { ok: false, field: "name", incomplete: false, message: "Enter a name of up to 80 characters." });
  assert.deepEqual(planConfigurationDraft(deployment, { ...draft, ownerEmail: "" }), { ok: false, field: "ownerEmail", incomplete: true, message: "Enter the first administrator's email address." });
  assert.deepEqual(planConfigurationDraft(deployment, { ...draft, ownerEmail: "owner@" }), { ok: false, field: "ownerEmail", incomplete: false, message: "Enter the first administrator's email address." });

  const gateway = editable({ target: { runtimeProfile: "gateway" } });
  const daytonaWithoutKey = planConfigurationDraft(gateway, { ...configurationDraft(gateway), target: { ...gateway.target, assistants: { ...gateway.target.assistants, computerProvider: "daytona" } } });
  assert.deepEqual(daytonaWithoutKey, { ok: false, field: null, incomplete: true, message: "Enter the ARN of your plain-string computer provider API key secret." }, "a value still to enter is not an error");
  const daytonaWithoutSnapshot = planConfigurationDraft(gateway, { ...configurationDraft(gateway), target: { ...gateway.target, assistants: { ...gateway.target.assistants, computerProvider: "daytona", computerSecretArn: SECRET_ARN } } });
  assert.equal(daytonaWithoutSnapshot.ok, false);
  assert.equal(daytonaWithoutSnapshot.ok ? null : daytonaWithoutSnapshot.incomplete, true);
  const foreignSecret = planConfigurationDraft(gateway, { ...configurationDraft(gateway), target: { ...gateway.target, assistants: { ...gateway.target.assistants, ...DAYTONA, computerProvider: "daytona", computerSecretArn: SECRET_ARN.replace("123456789012", "210987654321") } } });
  assert.deepEqual(foreignSecret, { ok: false, field: "target.assistants.computerSecretArn", incomplete: false, message: "Use a Secrets Manager secret in this deployment's AWS account and region." });

  const computersOnCore = planConfigurationDraft(deployment, { ...draft, target: { ...draft.target, assistants: { ...draft.target.assistants, ...DAYTONA, computerProvider: "daytona" } } });
  assert.deepEqual(computersOnCore, { ok: false, field: "target.assistants.computerProvider", incomplete: false, message: "Cloud computers need the gateway runtime. Turn it on to change them." });
  const removed = planConfigurationDraft(gateway, { ...configurationDraft(gateway), target: { ...gateway.target, runtimeProfile: "legacy" } });
  assert.equal(removed.ok, false);
  assert.match(removed.ok ? "" : removed.message, /^The gateway runtime can't be turned off\./);
});

test("adding the gateway runtime is locked with the reason and who can change it", () => {
  assert.equal(gatewayLockReason(editable(), true), null);
  assert.equal(gatewayLockReason(editable(), false), "The gateway runtime isn't enabled for this workspace. Ask your OpenWork operator.");
  const older = editable({ configuration: { gatewayAvailable: false }, view: { availableVersion: "1.2.3", updateAvailable: true } });
  assert.equal(gatewayLockReason(older, true), "Turn this on with Update to 1.2.3.");
  assert.equal(gatewayLockReason(editable({ configuration: { gatewayAvailable: false } }), true), "This deployment's installer isn't the published one. Ask your OpenWork operator.");

  const core = editable({ configuration: { gatewayAvailable: false } });
  const draft = configurationDraft(core);
  const email = accepted(core, { ...draft, ownerEmail: "owner@example.com" }).plan;
  assert.equal(planLockReason(core, email, false), null, "a core-only deployment's email needs neither the gateway feature nor the published installer");
  const adds = accepted(core, { ...draft, target: { ...draft.target, runtimeProfile: "gateway", assistants: gatewayAssistants(draft.target.assistants) } }).plan;
  assert.equal(planLockReason(core, adds, true), "This deployment's installer isn't the published one. Ask your OpenWork operator.");
  const gateway = editable({ target: { runtimeProfile: "gateway" } });
  const gatewayEmail = accepted(gateway, { ...configurationDraft(gateway), ownerEmail: "owner@example.com" }).plan;
  assert.equal(planLockReason(gateway, gatewayEmail, true), null);
  assert.match(planLockReason(gateway, gatewayEmail, false) ?? "", /isn't enabled for this workspace/);
});

test("the consent sentence names the account, the command, and only what this change does", () => {
  const core = editable();
  const emailOnly = consentSentence(core, [EMAIL_CHANGE]);
  assert.equal(emailOnly, "I'll approve this in AWS account 123456789012 by running one command in AWS CloudShell; nothing changes until I do. The OpenWork API and web app restart. OpenWork receives progress and health checks, never secret values.");

  const gateway = editable({ target: { runtimeProfile: "gateway" } });
  const computers = accepted(gateway, { ...configurationDraft(gateway), target: { ...gateway.target, assistants: { ...gateway.target.assistants, ...DAYTONA, computerProvider: "daytona" } } }).plan.changes;
  const computersOnly = consentSentence(gateway, computers);
  assert.match(computersOnly, /nothing changes until I do\. The OpenWork API and web app restart; the managed runner restarts; Daytona computers run outside my AWS account and are billed by Daytona\. OpenWork receives/, "every approved run restarts the API and web app");
  assert.doesNotMatch(computersOnly, /gateway runtime's services/);

  const withDaytona = editable({ target: { runtimeProfile: "gateway", assistants: DAYTONA } });
  const off = accepted(withDaytona, { ...configurationDraft(withDaytona), target: { ...withDaytona.target, assistants: { ...withDaytona.target.assistants, computerProvider: "off" } } }).plan.changes;
  assert.match(consentSentence(withDaytona, off), /The OpenWork API and web app restart; the managed runner restarts\. OpenWork receives/, "computers that are being turned off are not billed");
  assert.doesNotMatch(consentSentence(core, [{ field: "name", before: "Production", after: "Production EU", effect: "saved_immediately" }]), /restart/, "a rename restarts nothing");
  assert.doesNotMatch(consentSentence(withDaytona, [EMAIL_CHANGE]), /Daytona/, "computers the change leaves alone are not part of the consent");

  const draft = configurationDraft(core);
  const adds = accepted(core, { ...draft, target: { ...draft.target, runtimeProfile: "gateway", assistants: { ...gatewayAssistants(draft.target.assistants), computerProvider: "freestyle", computerSecretArn: SECRET_ARN } } }).plan.changes;
  assert.equal(consentSentence(core, adds), "I'll approve this in AWS account 123456789012 by running one command in AWS CloudShell; nothing changes until I do. The OpenWork API and web app restart; AWS adds and bills the gateway runtime's services, storage and backups, which can't be removed later; Freestyle computers run outside my AWS account and are billed by Freestyle. OpenWork receives progress and health checks, never secret values.");
  assert.doesNotMatch(consentSentence(core, accepted(core, { ...draft, target: { ...draft.target, runtimeProfile: "gateway", assistants: gatewayAssistants(draft.target.assistants) } }).plan.changes), /computers run outside/);
});

test("changes read as before and after, and what they do to the installation is said once per effect", () => {
  const core = editable();
  const draft = configurationDraft(core);
  const changes = accepted(core, { ...draft, name: "Production EU", ownerEmail: "owner@example.com", target: { ...draft.target, runtimeProfile: "gateway", assistants: { ...gatewayAssistants(draft.target.assistants), ...DAYTONA, computerProvider: "daytona" } } }).plan.changes;
  const groups = changeGroups(core, changes);
  assert.deepEqual(groups.map((group) => [group.effect, group.changes.length]), [["saved_immediately", 1], ["restarts_den", 1], ["adds_gateway_runtime", 1], ["restarts_runner", 3]]);
  assert.equal(groups[0]?.sentence, "Saved now. Nothing changes in AWS.");
  assert.equal(groups[1]?.sentence, "Changes who can complete first sign-in at openwork.example.com/setup. An administrator who has already signed in stays the administrator. The OpenWork API and web app restart.");
  assert.equal(groups[2]?.sentence, "Adds the model gateway, managed runner, Workbot, Slack and Automations, file storage and daily backups. They can't be removed later.");
  assert.equal(groups[3]?.sentence, "Starts with the gateway runtime's managed runner.");
  assert.equal(groups.filter((group) => group.sentence.includes("The OpenWork API and web app restart.")).length, 1, "the restart is said once, by the first change that needs approval");

  const addsOnly = changeGroups(core, accepted(core, { ...draft, target: { ...draft.target, runtimeProfile: "gateway", assistants: gatewayAssistants(draft.target.assistants) } }).plan.changes);
  assert.deepEqual(addsOnly.map((group) => group.sentence), ["Adds the model gateway, managed runner, Workbot, Slack and Automations, file storage and daily backups. They can't be removed later. The OpenWork API and web app restart."]);

  // The installer redeploys the API and web app on every run, so a computers-only change restarts them as well as the runner.
  const gateway = editable({ target: { runtimeProfile: "gateway", assistants: DAYTONA } });
  const rotatedDraft = { ...configurationDraft(gateway), target: { ...gateway.target, assistants: { ...gateway.target.assistants, computerSecretArn: SECRET_ARN.replace("computer-Ab12Cd", "rotated-Gh56Ij") } } };
  assert.deepEqual(changeGroups(gateway, accepted(gateway, rotatedDraft).plan.changes).map((group) => group.sentence), [
    "The OpenWork API and web app restart. The managed runner stops and starts again; work it is running at that moment is interrupted.",
  ]);
  assert.deepEqual(changeGroups(gateway, accepted(gateway, { ...rotatedDraft, ownerEmail: "owner@example.com" }).plan.changes).map((group) => group.sentence), [
    "Changes who can complete first sign-in at openwork.example.com/setup. An administrator who has already signed in stays the administrator. The OpenWork API and web app restart.",
    "The managed runner also stops and starts again; work it is running at that moment is interrupted.",
  ]);

  assert.equal(valueLabel("target.assistants.computerSnapshot", null), "Not set");
  assert.deepEqual(["off", "daytona", "freestyle"].map((value) => valueLabel("target.assistants.computerProvider", value)), ["Off", "Daytona", "Freestyle"]);
  assert.deepEqual(["legacy", "gateway"].map((value) => valueLabel("target.runtimeProfile", value, core)), ["Core services only", "Gateway runtime"]);
  assert.equal(valueLabel("target.runtimeProfile", "legacy", editable({ target: { assistants: OWN_RUNNER } })), "Core services and its own runner");
  assert.equal(valueLabel("target.assistants.computerSecretArn", SECRET_ARN), SECRET_ARN);
});

test("the values fixed at installation are listed as the deployment has them", () => {
  assert.deepEqual(fixedConfigurationRows(editable()).map((row) => [row.label, row.value]), [
    ["Address", "openwork.example.com"], ["AWS account", "123456789012"], ["Region", "us-east-1"], ["Hosted zone", "ZTEST"], ["Network", "Dedicated VPC"], ["Size", "Small"],
  ]);
  const existing = editable({ target: { network: { mode: "existing", vpcId: "vpc-0abc12345", serviceSubnetIds: ["subnet-0aaa11111", "subnet-0bbb22222"], loadBalancerSubnetIds: ["subnet-0ccc33333", "subnet-0ddd44444"], ecsClusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/platform" } } });
  assert.equal(fixedConfigurationRows(existing).find((row) => row.label === "Network")?.value, "vpc-0abc12345 · cluster platform");
});

test("the state line says what is true of a requested change", () => {
  const time = (iso: string) => iso.slice(11, 16);
  assert.equal(changeStateLine({ state: "awaiting_approval", ...TIMES }, time), "Nothing has changed yet. The approval expires at 14:05.");
  assert.equal(changeStateLine({ state: "expired", ...TIMES }, time), "Not approved within 3 hours. Nothing changed.");
  assert.match(changeStateLine({ state: "failed", ...TIMES }, time), /^AWS may be partly changed\./);
  assert.match(changeStateLine({ state: "applying", ...TIMES }, time), /^AWS is applying this now\./);
});

test("the runtime block points to Edit configuration only when that can be used", () => {
  const deployment = view();
  const needsNewerInstaller = assistantSettingsState(deployment, true, true).reason;
  assert.match(needsNewerInstaller ?? "", /newer installer/);
  const usable = configurationEntry(deployment, { enabled: true, canManage: true });
  assert.deepEqual(runtimeBlock(deployment, needsNewerInstaller, usable, true), { reason: null, viaConfiguration: true }, "the core-services block names Edit configuration itself");
  const gateway = view({ target: { runtimeProfile: "gateway" } });
  assert.deepEqual(runtimeBlock(gateway, needsNewerInstaller, usable, true), { reason: "Use Edit configuration to change cloud computers.", viaConfiguration: true });
  const today = { reason: needsNewerInstaller, viaConfiguration: false };
  assert.deepEqual(runtimeBlock(deployment, needsNewerInstaller, configurationEntry(deployment, { enabled: false, canManage: true }), true), today, "flag off: today's sentence");
  assert.deepEqual(runtimeBlock(deployment, needsNewerInstaller, configurationEntry(view({ configuration: { lock: "unfinished_run" } }), { enabled: true, canManage: true }), true), today);
  const notEnabled = assistantSettingsState(deployment, false, true).reason;
  assert.deepEqual(runtimeBlock(deployment, notEnabled, usable, false), { reason: notEnabled, viaConfiguration: false });
  const readOnly = assistantSettingsState(deployment, true, false).reason;
  assert.deepEqual(runtimeBlock(deployment, readOnly, configurationEntry(deployment, { enabled: true, canManage: false }), true), { reason: readOnly, viaConfiguration: false });
  assert.deepEqual(runtimeBlock(deployment, null, usable, true), { reason: null, viaConfiguration: false }, "an Update that can carry the gateway keeps its own control");

  const awaiting = view({ view: { run: run() } });
  const frozen = assistantSettingsState(awaiting, true, true).reason;
  assert.deepEqual(runtimeBlock(awaiting, frozen, usable, true), { reason: frozen, viaConfiguration: false }, "a live approval keeps its own sentence");
});

function run(overrides: Record<string, unknown> = {}) {
  return { id: "00000000-0000-4000-8000-000000000002", kind: "configure", version: "1.2.2", state: "awaiting_approval", createdAt: TIMES.requestedAt, lastSeenAt: null, expiresAt: TIMES.expiresAt, expired: false, events: [], ...overrides };
}

test("an approval command stays on the page only for the run it was issued for, while that run awaits approval", () => {
  const issued = view({ view: { run: run() } });
  const handoff = { deployment: issued, command: "the command issued for run 2" };
  assert.equal(currentHandoff(handoff, issued), handoff);
  assert.equal(currentHandoff(null, issued), null);

  const replaced = view({ view: { run: run({ id: "00000000-0000-4000-8000-000000000003" }) } });
  assert.equal(currentHandoff(handoff, replaced), null, "someone replaced the change: the new run has another command");
  const withdrawn = view({ view: { run: run({ id: "00000000-0000-4000-8000-000000000009", kind: "install", state: "ready" }) } });
  assert.equal(currentHandoff(handoff, withdrawn), null, "the change was withdrawn: the deployment shows its earlier run");
  assert.equal(currentHandoff(handoff, view()), null, "no run at all");
  assert.equal(currentHandoff(handoff, view({ view: { run: run({ expired: true }) } })), null, "the approval ran out");
  assert.equal(currentHandoff(handoff, view({ view: { run: run({ lastSeenAt: new Date().toISOString() }) } })), null, "the shell already reserved this approval");
  for (const state of ["provisioning", "failed", "ready"]) assert.equal(currentHandoff(handoff, view({ view: { run: run({ state }) } })), null, `${state}: the command has been used`);
  assert.equal(currentHandoff(handoff, view({ view: { id: "00000000-0000-4000-8000-00000000000a", run: run() } })), null, "another deployment");

  const update = { deployment: view({ configuration: null, view: { run: run({ kind: "update" }) } }) };
  assert.equal(currentHandoff(update, view({ configuration: null, view: { run: run({ kind: "update" }) } })), update, "the same rule holds for installs and updates");
});

test("a change nobody approved in time has no progress to show", () => {
  assert.equal(changeNeverApproved({ kind: "configure", state: "awaiting_approval", expired: true }), true);
  assert.equal(changeNeverApproved({ kind: "configure", state: "awaiting_approval", expired: true, lastSeenAt: new Date().toISOString() }), false, "an expired reservation is not proof AWS was untouched");
  assert.match(changeStateLine({ state: "applying", requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString() }, undefined, true), /approval is reserved.*can't be discarded/);
  assert.equal(changeNeverApproved({ kind: "configure", state: "awaiting_approval", expired: false }), false, "still approvable");
  assert.equal(changeNeverApproved({ kind: "configure", state: "provisioning", expired: true }), false, "it started: its steps say where it stopped");
  assert.equal(changeNeverApproved({ kind: "configure", state: "failed", expired: false }), false);
  assert.equal(changeNeverApproved({ kind: "update", state: "awaiting_approval", expired: true }), false, "installs and updates keep today's screen");
});

test("a failed change says to review the change, the action the page offers, and never to retry", () => {
  for (const code of ["release_verification_failed", "infrastructure_failed", "certificate_failed", "service_unhealthy", "health_check_failed", "network_check_failed", "runner_failed"]) {
    const sentence = changeFailureMessage(code);
    assert.ok(sentence, code);
    assert.doesNotMatch(sentence, /retry/i, code);
  }
  assert.match(changeFailureMessage("infrastructure_failed") ?? "", /then review the change and try again\.$/);
  assert.equal(changeFailureMessage("something_new"), null);
  assert.match(CHANGE_STOPPED_REPORTING, /then review the change and try again\.$/);
  assert.doesNotMatch(CHANGE_STOPPED_REPORTING, /retry/i);
});
