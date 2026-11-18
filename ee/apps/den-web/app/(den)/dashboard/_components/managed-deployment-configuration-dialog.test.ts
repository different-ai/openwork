import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { gatewayAssistants, managedDeploymentSchema, type AwsManagedDeploymentInput } from "@openwork/types/den/managed-deployments";
import { ConfigurationChangeForm, ConfigurationChangeReview } from "./managed-deployment-configuration-dialog";
import { configurationDraft, hasConfiguration, planConfigurationDraft, type EditableDeployment } from "./managed-deployment-configuration-state";
import { ManagedDeploymentConfigurationSummary } from "./managed-deployment-configuration-summary";

const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:managed/computer-Ab12Cd";
const noop = () => undefined;
const controls = { onEdit: noop, onResult: noop, runReauthableAction: async () => undefined, reauthDialogOpen: false };

function deployment(options: { target?: Record<string, unknown>; configuration?: Record<string, unknown>; view?: Record<string, unknown> } = {}): EditableDeployment {
  const parsed = managedDeploymentSchema.parse({
    id: "00000000-0000-4000-8000-000000000001", name: "Production", provider: "aws",
    target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST", ...options.target },
    domainName: "openwork.example.com", ownerEmail: "admin@example.com", size: "small", updateMode: "approval",
    createdAt: "2026-10-01T00:00:00.000Z", webUrl: "https://openwork.example.com", consoleUrl: "https://console.example.com",
    installedVersion: "1.2.2", availableVersion: "1.2.2", updateAvailable: false,
    health: { state: "operational", reportedAt: "2026-10-01T00:00:00.000Z", version: "1.2.2", checks: [] },
    run: null,
    configuration: { revision: "a".repeat(64), lock: null, gatewayAvailable: true, change: null, ...options.configuration },
    ...options.view,
  });
  if (!hasConfiguration(parsed)) throw new Error("Fixture is not an editable AWS deployment");
  return parsed;
}

function form(item: EditableDeployment, options: { assistantsAvailable?: boolean; draft?: AwsManagedDeploymentInput } = {}) {
  const draft = options.draft ?? configurationDraft(item);
  return renderToStaticMarkup(createElement(ConfigurationChangeForm, {
    deployment: item, draft, onDraft: noop, planned: planConfigurationDraft(item, draft), assistantsAvailable: options.assistantsAvailable ?? true, onReview: noop,
  }));
}

/** The opening tag of the element carrying a test id. */
function tag(html: string, testId: string) {
  return html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
}

test("the form opens with the current values and shows what can never change, with the reason", () => {
  const html = form(deployment());
  assert.ok(html.includes('value="Production"'));
  assert.ok(html.includes('value="admin@example.com"'));
  assert.ok(html.includes("Fixed at installation"));
  assert.ok(html.includes("Set when the deployment was installed. Create a new deployment to use different values."));
  for (const [label, value] of [["Address", "openwork.example.com"], ["AWS account", "123456789012"], ["Region", "us-east-1"], ["Hosted zone", "ZTEST"], ["Network", "Dedicated VPC"], ["Size", "Small"]]) {
    assert.match(html, new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>${value}<svg`), `${label} is a locked row`);
  }
  assert.equal((html.match(/<input/g) ?? []).length, 2, "only the name and the first administrator email are inputs");
  assert.ok(!html.includes('role="alert"'));
  assert.match(tag(html, "deployment-configuration-review"), / disabled=""/, "nothing to review until something changed");
});

test("a core-only deployment can add the gateway runtime, and the button is locked with its reason when it can't", () => {
  const available = form(deployment());
  assert.ok(available.includes("Core services only"));
  assert.doesNotMatch(tag(available, "deployment-configuration-add-gateway"), / disabled=""/);
  assert.ok(!available.includes("deployment-configuration-gateway-lock"));
  assert.ok(!available.includes("Cloud computers (optional)"), "computers belong to the gateway runtime");

  const olderInstaller = form(deployment({ configuration: { gatewayAvailable: false }, view: { availableVersion: "1.2.3", updateAvailable: true } }));
  assert.match(tag(olderInstaller, "deployment-configuration-add-gateway"), / disabled=""/);
  assert.match(olderInstaller, /data-testid="deployment-configuration-gateway-lock"><svg[^>]*>.*?<\/svg>Turn this on with Update to 1\.2\.3\.<\/p>/);

  const unpublished = form(deployment({ configuration: { gatewayAvailable: false } }));
  assert.match(tag(unpublished, "deployment-configuration-add-gateway"), / disabled=""/);
  assert.ok(unpublished.includes("This deployment&#x27;s installer isn&#x27;t the published one. Ask your OpenWork operator."));

  const notEnabled = form(deployment(), { assistantsAvailable: false });
  assert.match(tag(notEnabled, "deployment-configuration-add-gateway"), / disabled=""/);
  assert.ok(notEnabled.includes("The gateway runtime isn&#x27;t enabled for this workspace. Ask your OpenWork operator."));
});

test("adding the gateway runtime shows its services and computers, takes ARNs only, and can be undone before review", () => {
  const item = deployment();
  const base = configurationDraft(item);
  const draft: AwsManagedDeploymentInput = { ...base, target: { ...base.target, runtimeProfile: "gateway", assistants: { ...gatewayAssistants(base.target.assistants), computerProvider: "daytona" } } };
  const html = form(item, { draft });
  assert.equal((html.match(/>Included</g) ?? []).length, 5);
  assert.ok(html.includes("Daytona key secret ARN"));
  assert.ok(html.includes("enter only its complete ARN, without a JSON field or version suffix"));
  assert.ok(!html.includes('type="password"'));
  assert.ok(html.includes("Keep core services only"));
  assert.ok(!html.includes("deployment-configuration-add-gateway"));
  assert.match(html, /role="alert"[^>]*>Enter the ARN of your plain-string computer provider API key secret\.</);
  assert.match(tag(html, "deployment-configuration-review"), / disabled=""/);
});

test("a gateway deployment edits its computers in place, and a change enables the review", () => {
  const item = deployment({ target: { runtimeProfile: "gateway" } });
  const base = configurationDraft(item);
  assert.ok(form(item).includes("Cloud computers (optional)"));
  assert.ok(!form(item).includes("Add gateway runtime"));
  const edited = form(item, { draft: { ...base, ownerEmail: "owner@example.com" } });
  assert.doesNotMatch(tag(edited, "deployment-configuration-review"), / disabled=""/);
  const locked = form(item, { draft: { ...base, ownerEmail: "owner@example.com" }, assistantsAvailable: false });
  assert.match(tag(locked, "deployment-configuration-review"), / disabled=""/);
  assert.match(locked, /data-testid="deployment-configuration-lock"><svg[^>]*>.*?<\/svg>The gateway runtime isn&#x27;t enabled for this workspace\./);
});

test("the review shows before and after, what each change does, and asks for consent before preparing the approval", () => {
  const item = deployment();
  const base = configurationDraft(item);
  const planned = planConfigurationDraft(item, { ...base, ownerEmail: "owner@example.com", target: { ...base.target, runtimeProfile: "gateway", assistants: { ...gatewayAssistants(base.target.assistants), computerProvider: "daytona", computerSecretArn: SECRET_ARN, computerSnapshot: "computer-snapshot" } } });
  if (!planned.ok) throw new Error(planned.message);
  const review = (consent: boolean) => renderToStaticMarkup(createElement(ConfigurationChangeReview, { deployment: item, plan: planned.plan, consent, onConsent: noop, onBack: noop, onSubmit: noop }));
  const html = review(false);
  assert.deepEqual([...html.matchAll(/data-testid="deployment-configuration-change" data-field="([^"]+)"/g)].map((match) => match[1]), [
    "ownerEmail", "target.runtimeProfile", "target.assistants.computerProvider", "target.assistants.computerSecretArn", "target.assistants.computerSnapshot",
  ]);
  assert.match(html, /First administrator email<\/p><dl[^>]*><dt[^>]*>Before<\/dt><dd[^>]*>admin@example\.com<\/dd><dt[^>]*>After<\/dt><dd[^>]*>owner@example\.com<\/dd>/);
  assert.match(html, /Runtime<\/p><dl[^>]*><dt[^>]*>Before<\/dt><dd[^>]*>Core services only<\/dd><dt[^>]*>After<\/dt><dd[^>]*>Gateway runtime<\/dd>/);
  assert.match(html, /Cloud computers<\/p><dl[^>]*><dt[^>]*>Before<\/dt><dd[^>]*>Off<\/dd><dt[^>]*>After<\/dt><dd[^>]*>Daytona<\/dd>/);
  assert.match(html, new RegExp(`Before</dt><dd[^>]*>Not set</dd><dt[^>]*>After</dt><dd[^>]*>${SECRET_ARN}</dd>`));
  assert.equal((html.match(/data-testid="deployment-configuration-change-effect"/g) ?? []).length, 3, "the three computer values share one sentence");
  assert.ok(html.includes("An administrator who has already signed in stays the administrator."));
  assert.ok(html.includes("They can&#x27;t be removed later."));
  assert.match(html, /data-testid="deployment-configuration-consent"[^>]*>I&#x27;ll approve this in AWS account 123456789012 by running one command in AWS CloudShell; nothing changes until I do\./);
  assert.ok(html.includes('role="checkbox"'));
  assert.match(tag(html, "deployment-configuration-submit"), / disabled=""/);
  assert.match(html, /data-testid="deployment-configuration-submit"[^>]*>.*?Prepare AWS approval/);
  assert.doesNotMatch(tag(review(true), "deployment-configuration-submit"), / disabled=""/);
});

test("a rename alone is saved without consent or an AWS approval", () => {
  const item = deployment();
  const planned = planConfigurationDraft(item, { ...configurationDraft(item), name: "Production EU" });
  if (!planned.ok) throw new Error(planned.message);
  const html = renderToStaticMarkup(createElement(ConfigurationChangeReview, { deployment: item, plan: planned.plan, consent: false, onConsent: noop, onBack: noop, onSubmit: noop }));
  assert.ok(html.includes("Saved now. Nothing changes in AWS."));
  assert.ok(!html.includes('role="checkbox"'));
  assert.ok(!html.includes("Prepare AWS approval"));
  assert.match(html, /data-testid="deployment-configuration-submit"[^>]*>.*?Save name/);
  assert.doesNotMatch(tag(html, "deployment-configuration-submit"), / disabled=""/);
});

test("a requested change on the deployment says what is true and offers only the actions of its state", () => {
  const item = deployment();
  const requested = { ...configurationDraft(item), ownerEmail: "owner@example.com" };
  const summary = (state: string, options: { canManage?: boolean; commandShown?: boolean } = {}) => renderToStaticMarkup(createElement(ManagedDeploymentConfigurationSummary, {
    deployment: deployment({ configuration: { change: {
      runId: "00000000-0000-4000-8000-000000000002", state, requestedAt: "2026-10-01T11:05:00.000Z", expiresAt: "2026-10-01T14:05:00.000Z", requested,
      changes: [{ field: "ownerEmail", before: "admin@example.com", after: "owner@example.com", effect: "restarts_den" }],
    } } }),
    canManage: options.canManage ?? true, commandShown: options.commandShown ?? false, controls,
  }));
  const actions = (html: string) => ["show-command", "prepare-again", "try-again", "edit-change", "discard"].filter((name) => html.includes(`data-testid="managed-deployment-configuration-${name}"`));

  const awaiting = summary("awaiting_approval");
  assert.match(awaiting, /data-change-state="awaiting_approval"/);
  assert.ok(awaiting.includes("Nothing has changed yet. The approval expires at"));
  assert.match(awaiting, /Before<\/dt><dd[^>]*>admin@example\.com<\/dd><dt[^>]*>After<\/dt><dd[^>]*>owner@example\.com<\/dd>/);
  assert.deepEqual(actions(awaiting), ["show-command", "edit-change", "discard"]);
  assert.deepEqual(actions(summary("awaiting_approval", { commandShown: true })), ["edit-change", "discard"], "the command is already on the page");
  assert.deepEqual(actions(summary("applying")), []);
  assert.deepEqual(actions(summary("failed")), ["try-again"]);
  assert.ok(summary("failed").includes("AWS may be partly changed."));
  assert.deepEqual(actions(summary("expired")), ["prepare-again", "discard"]);
  assert.ok(summary("expired").includes("Not approved within 3 hours. Nothing changed."));

  const readOnly = summary("awaiting_approval", { canManage: false });
  for (const name of ["show-command", "edit-change", "discard"]) assert.match(tag(readOnly, `managed-deployment-configuration-${name}`), / disabled=""/, name);
  assert.equal(renderToStaticMarkup(createElement(ManagedDeploymentConfigurationSummary, { deployment: item, canManage: true, commandShown: false, controls })), "");
});
