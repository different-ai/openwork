import assert from "node:assert/strict";
import { test } from "node:test";
import { managedDeploymentSchema } from "@openwork/types/den/managed-deployments";
import { assistantSettingsState, availableUpdate, deploymentStatus, providerName, readinessMessage, updateLabel, type ProviderReadiness } from "./managed-deployments-state";

function deployment(provider: "aws" | "gcp" = "aws") {
  return managedDeploymentSchema.parse({
    id: "00000000-0000-4000-8000-000000000001", name: "Test deployment", provider,
    target: provider === "aws" ? { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" }
      : { projectId: "openwork-test", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "example-test" },
    domainName: "openwork.example.test", ownerEmail: "admin@example.test", size: "small", updateMode: "approval",
    createdAt: "2026-10-01T00:00:00.000Z", webUrl: "https://openwork.example.test", consoleUrl: "https://console.example.test",
    installedVersion: "0.18.56", availableVersion: "0.18.57", updateAvailable: true,
    health: { state: "operational", reportedAt: "2026-10-01T00:00:00.000Z", version: "0.18.56", checks: [] },
    run: { id: "00000000-0000-4000-8000-000000000002", kind: "update", version: "0.18.57", state: "failed",
      createdAt: "2026-10-01T00:00:00.000Z", lastSeenAt: null, expiresAt: "2026-10-02T00:00:00.000Z", expired: false, events: [] },
  });
}

test("failed updates are not masked by operational health on either cloud", () => {
  for (const provider of ["aws", "gcp"] satisfies ("aws" | "gcp")[]) {
    const item = deployment(provider);
    assert.deepEqual(deploymentStatus(item), { label: "Update failed", tone: "danger" });
    if (!item.run) throw new Error("Missing fixture run");
    item.run.expired = true;
    assert.deepEqual(deploymentStatus(item), { label: "Update stopped reporting", tone: "danger" });
  }
});

test("pending approval names the cloud, not the last known health", () => {
  const item = deployment("gcp");
  if (!item.run) throw new Error("Missing fixture run");
  item.run.state = "awaiting_approval";
  assert.equal(deploymentStatus(item).label, "Awaiting Google Cloud approval");
  item.installedVersion = null;
  assert.equal(deploymentStatus(item).label, "Awaiting Google Cloud approval");
  item.run = null;
  assert.equal(deploymentStatus(item).label, "Not launched");
});

test("completed runs return to health even after their approval expires", () => {
  const item = deployment();
  if (!item.run) throw new Error("Missing fixture run");
  item.run.state = "ready";
  item.run.expired = true;
  assert.deepEqual(deploymentStatus(item), { label: "Operational", tone: "neutral" });
});

test("locks name the remediation owner and distinguish readiness causes", () => {
  const reasons: NonNullable<ProviderReadiness["reason"]>[] = ["not_configured", "invalid_configuration", "feature_disabled", "not_supported"];
  const messages = reasons.map((reason) => readinessMessage({ provider: "gcp", available: false, reason, missingFields: ["DEN_MANAGED_DEPLOYMENT_GCP_VERSION"] }));
  assert.equal(new Set(messages).size, reasons.length);
  for (const message of messages) {
    assert.match(message, /Google Cloud/);
    assert.match(message, /OpenWork operator/);
    assert.doesNotMatch(message, /DEN_MANAGED/);
  }
  assert.match(readinessMessage({ provider: "aws", available: false }), /publish and configure a verified installer/);
  assert.equal(providerName("azure"), "Azure");
});

test("assistant settings are editable only for a newer Update and stay locked during approval or provisioning", () => {
  const item = deployment();
  assert.equal(assistantSettingsState(item, true, true).editable, true);
  assert.match(assistantSettingsState(item, false, true).reason ?? "", /OpenWork operator/);
  assert.match(assistantSettingsState(item, true, false).reason ?? "", /Read only/);
  if (!item.run) throw new Error("Missing fixture run");
  item.run.state = "awaiting_approval";
  assert.match(assistantSettingsState(item, true, true).reason ?? "", /frozen/);
  item.run.state = "provisioning";
  assert.equal(assistantSettingsState(item, true, true).editable, false);
  item.run.expired = true;
  assert.equal(assistantSettingsState(item, true, true).editable, true);
  item.updateAvailable = false;
  assert.match(assistantSettingsState(item, true, true).reason ?? "", /Retry keeps/);
});

test("a configuration change has its own status, and one nobody approved in time leaves the health status", () => {
  const item = deployment();
  if (!item.run) throw new Error("Missing fixture run");
  item.run.kind = "configure";
  item.run.version = "0.18.56";
  item.run.state = "awaiting_approval";
  assert.deepEqual(deploymentStatus(item), { label: "Awaiting AWS approval", tone: "neutral" });
  item.run.expired = true;
  assert.deepEqual(deploymentStatus(item), { label: "Operational", tone: "neutral" }, "nothing reached AWS, so the installation is as healthy as it reports");
  item.run.lastSeenAt = new Date().toISOString();
  assert.deepEqual(deploymentStatus(item), { label: "AWS approval reserved", tone: "neutral" });
  item.run.lastSeenAt = null;
  item.run.state = "provisioning";
  assert.deepEqual(deploymentStatus(item), { label: "Configuration change stopped reporting", tone: "danger" });
  item.run.expired = false;
  assert.deepEqual(deploymentStatus(item), { label: "Applying configuration change", tone: "neutral" });
  item.run.state = "failed";
  assert.deepEqual(deploymentStatus(item), { label: "Configuration change failed", tone: "danger" });
  item.run.expired = true;
  assert.deepEqual(deploymentStatus(item), { label: "Configuration change failed", tone: "danger" });
  item.run.state = "ready";
  assert.deepEqual(deploymentStatus(item), { label: "Operational", tone: "neutral" });
});

test("an update that keeps the installed version is named as an installer update, by its revision", () => {
  const item = deployment();
  assert.equal(item.installedInstallerRevision, null, "a view from before revisions existed still parses");
  assert.equal(item.run?.installerRevision, 1);
  assert.deepEqual(availableUpdate(item), { action: "Update to 0.18.57", note: "0.18.57 available" }, "a version update reads as it always has");

  const installerOnly = { ...item, installedVersion: "0.18.57", installedInstallerRevision: 1, availableVersion: "0.18.57", availableInstallerRevision: 2 };
  assert.deepEqual(availableUpdate(installerOnly), { action: "Update installer for 0.18.57 (revision 2)", note: "installer revision 2 available" });
  assert.equal(availableUpdate({ ...installerOnly, updateAvailable: false }), null);
  assert.equal(availableUpdate({ ...installerOnly, availableVersion: null }), null);

  const both = { ...item, availableVersion: "0.18.58", availableInstallerRevision: 3 };
  assert.deepEqual(availableUpdate(both), { action: "Update to 0.18.58 (revision 3)", note: "0.18.58 (revision 3) available" });

  // The run an approved update becomes keeps the name its button had.
  assert.equal(updateLabel(installerOnly, { version: "0.18.57", installerRevision: 2 }), "Update installer for 0.18.57 (revision 2)");
  assert.equal(updateLabel(item, { version: "0.18.57", installerRevision: 1 }), "Update to 0.18.57");
  assert.equal(updateLabel(item, { version: "0.18.58", installerRevision: 3 }), "Update to 0.18.58 (revision 3)");
  assert.equal(updateLabel({ installedVersion: "0.18.57" }, { version: "0.18.57" }), "Update to 0.18.57", "without a revision there is nothing to tell apart");
});

test("an installer-only update unlocks the runtime profile and computers like any other Update", () => {
  const item = { ...deployment(), installedVersion: "0.18.57", installedInstallerRevision: 1, availableVersion: "0.18.57", availableInstallerRevision: 2, run: null };
  assert.equal(assistantSettingsState(item, true, true).editable, true);
});
