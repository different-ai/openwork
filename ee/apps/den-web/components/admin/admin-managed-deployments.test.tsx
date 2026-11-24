import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagedInstallerProviderState, ManagedInstallerQualification, ManagedInstallerReport, ManagedInstallerValidation } from "@openwork/types/den/managed-installer-releases";
import { ManagedDeploymentEditor, ManagedDeploymentCurrent, ManagedDeploymentHistory, ManagedDeploymentPreview, ManagedDeploymentsSkeleton } from "./admin-managed-deployments";
import { managedServiceLabel, managedSourceLabel, parseManagedLatest, parseManagedReport, parseManagedValidation, pinBlockedReason, sourceInputError, versionInputError } from "./admin-managed-deployments-model";

const source = "https://example.s3.us-east-1.amazonaws.com/releases/aws/";
const current: ManagedInstallerProviderState = {
  provider: "aws", sourceBaseUrl: source, source: "environment", available: true, approvalMode: "platform_admin", pendingValidation: null,
  revision: "a".repeat(64), updatedAt: null,
  release: { version: "1.2.2", templateUrl: `${source}1.2.2/template.yaml`, bundleUrl: `${source}1.2.2/bundle.tar.gz`, bundleSha256: "b".repeat(64) },
};
const validation: ManagedInstallerValidation = {
  id: "00000000-0000-4000-8000-000000000001", provider: "aws", verifiedBy: "fixture-admin", canPin: true,
  release: { version: "1.2.3", templateUrl: `${source}1.2.3/template.yaml`, bundleUrl: `${source}1.2.3/bundle.tar.gz`, bundleSha256: "c".repeat(64) },
  manifestSha256: "d".repeat(64), services: ["den_api", "den_web", "headless_runner", "workbot", "ai_gateway"],
  verifiedAt: "2026-11-17T12:00:00.000Z", expiresAt: "2026-11-17T12:15:00.000Z",
};
const qualification: ManagedInstallerQualification = {
  freshInstallUrl: "https://example.test/reports/fresh-install", approvedUpdateUrl: "https://example.test/reports/approved-update",
};
const now = Date.parse("2026-11-17T12:05:00.000Z");

test("report, verification and latest lookup require shared contract data", () => {
  assert.deepEqual(parseManagedReport({ providers: [current], history: [] })?.providers, [current]);
  assert.deepEqual(parseManagedValidation(validation), validation);
  assert.deepEqual(parseManagedLatest({ version: "1.2.3", url: "https://example.test/releases/1.2.3" })?.version, "1.2.3");
  for (const payload of [null, {}, { providers: [{}], history: [] }]) assert.equal(parseManagedReport(payload), null);
  assert.equal(parseManagedValidation({ ...validation, manifestSha256: "unverified" }), null);
  assert.equal(parseManagedLatest({ version: "latest", url: "https://example.test" }), null);
});

test("source and version fields reject malformed inputs without sending writes", () => {
  assert.equal(sourceInputError(source, current.revision), null);
  for (const url of ["", "http://example.test/releases", "https://user:password@example.test/releases", "https://example.test/releases#fragment"]) assert.ok(sourceInputError(url, current.revision));
  assert.equal(versionInputError(current, "1.2.3"), null);
  for (const version of ["latest", "1.2.3-beta.1", "v1.2.3", "01.2.3", ""]) assert.ok(versionInputError(current, version));
});

test("pin is locked without matching verification, two reports, freshness and current revision", () => {
  assert.equal(pinBlockedReason(validation, current, "1.2.3", qualification, now, false), null);
  assert.equal(pinBlockedReason({ ...validation, canPin: false }, current, "1.2.3", qualification, now, false), "Another platform administrator must pin this verified release.");
  assert.match(pinBlockedReason(null, current, "1.2.3", qualification, now, false) ?? "", /Verify/);
  assert.match(pinBlockedReason(validation, current, "1.2.4", qualification, now, false) ?? "", /Verify/);
  assert.match(pinBlockedReason({ ...validation, provider: "gcp" }, current, "1.2.3", qualification, now, false) ?? "", /Verify/);
  assert.match(pinBlockedReason(validation, current, "1.2.3", { ...qualification, approvedUpdateUrl: "" }, now, false) ?? "", /fresh install and an approved update/);
  assert.match(pinBlockedReason(validation, current, "1.2.3", qualification, Date.parse(validation.expiresAt), false) ?? "", /expired/);
  assert.match(pinBlockedReason(validation, current, "1.2.3", qualification, now, true) ?? "", /Refresh/);
});

test("current default emphasizes version and source without exposing diagnostic coordinates", () => {
  const html = renderToStaticMarkup(<ManagedDeploymentCurrent state={current} />);
  assert.ok(html.includes("Current default") && html.includes("1.2.2") && html.includes("Environment"));
  assert.ok(!html.includes(current.revision) && !html.includes(current.release?.bundleUrl ?? "missing"));
  assert.equal(managedSourceLabel("admin"), "Admin");
  assert.equal(managedSourceLabel("invalid_configuration"), "Invalid configuration");
});

test("not configured and invalid defaults provide an inline configuration direction", () => {
  const html = renderToStaticMarkup(<ManagedDeploymentCurrent state={{ ...current, release: null, sourceBaseUrl: null, source: "unconfigured", available: false }} />);
  assert.ok(html.includes("Not configured") && html.includes("Configure a release folder under Advanced"));
  const invalid = renderToStaticMarkup(<ManagedDeploymentCurrent state={{ ...current, source: "invalid_configuration", available: false }} />);
  assert.ok(invalid.includes("environment default is invalid") && invalid.includes("Configure a published release source"));
});

test("verified preview names the exact returned inventory and does not claim cloud qualification", () => {
  const html = renderToStaticMarkup(<ManagedDeploymentPreview validation={validation} />);
  assert.ok(html.includes("Verified release 1.2.3"));
  assert.ok(html.includes("Den API, Den web, Managed runner, Workbot, Model gateway"));
  for (const service of ["den_api", "den_web", "headless_runner", "ai_gateway"]) assert.ok(!html.includes(service));
  assert.equal(managedServiceLabel("future_service"), "future_service");
  assert.ok(html.includes("Nov 17, 2026") && html.includes("12:00") && html.includes("12:15"));
  assert.ok(html.includes("Cloud qualification requires the test reports below"));
  assert.ok(!html.includes("Automatically qualified") && !html.includes("Published to S3"));
});

test("history shows actor, action, timestamp and recorded evidence only for selected provider", () => {
  const history: ManagedInstallerReport["history"] = [{ id: "change-1", provider: "aws", action: "pinned", version: "1.2.3", actor: "Developer", createdAt: validation.verifiedAt, manifestSha256: validation.manifestSha256, qualification }];
  const html = renderToStaticMarkup(<ManagedDeploymentHistory history={history} provider="aws" />);
  for (const text of ["Pinned 1.2.3", "Developer", "Nov 17, 2026", qualification.freshInstallUrl, qualification.approvedUpdateUrl]) assert.ok(html.includes(text));
  const empty = renderToStaticMarkup(<ManagedDeploymentHistory history={history} provider="gcp" />);
  assert.ok(empty.includes("No admin changes recorded") && !empty.includes("Developer"));
});

test("pending verification opens ready for another administrator with the server permission intact", () => {
  const state: ManagedInstallerProviderState = { ...current, approvalMode: "independent_admin", pendingValidation: { ...validation, expiresAt: "2099-11-17T12:15:00.000Z", canPin: false } };
  const unexpectedWrite = () => { throw new Error("Rendering must not change policy or pin a release."); };
  const html = renderToStaticMarkup(<ManagedDeploymentEditor state={state} report={{ providers: [state], history: [] }} onReport={unexpectedWrite} onAccess={unexpectedWrite} refresh={unexpectedWrite} refreshing={false} />);
  for (const text of ["Verified release 1.2.3", 'value="1.2.3"', "Another platform administrator must pin this verified release.", "Successful fresh install report", "Approved update report", "Second administrator", "One administrator", "Save approval policy"]) assert.ok(html.includes(text), `missing: ${text}`);
  assert.ok(html.includes("New installs and available updates. Existing installations change only through an owner-approved Update."));
  assert.ok(!html.includes("Confirm one administrator"));
});

test("approval policy history is named without exposing configuration internals", () => {
  const history: ManagedInstallerReport["history"] = [{ id: "policy-change", provider: "aws", action: "approval_saved", version: null, actor: "Developer", createdAt: validation.verifiedAt, manifestSha256: null, qualification: null }];
  const html = renderToStaticMarkup(<ManagedDeploymentHistory history={history} provider="aws" />);
  assert.ok(html.includes("Changed approval policy") && html.includes("Developer"));
  assert.ok(!html.includes("Restored environment default"));
});

test("loading preserves the destination layout without exposing configuration fields", () => {
  const html = renderToStaticMarkup(<ManagedDeploymentsSkeleton />);
  assert.ok(html.includes('aria-busy="true"') && html.includes("Managed deployments"));
  assert.ok(!html.includes("<input") && !html.includes("Checking admin access"));
});
