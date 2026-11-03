import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeploymentCapabilities, type DeploymentCapabilities } from "@openwork/types/den/deployment-capabilities";
import type { OrganizationServiceReadiness, ServiceId } from "@openwork/types/den/service-readiness";
import { formatServiceTime, serviceCheckLine, workbotDeploymentNotice } from "./service-readiness";

const checkedAt = "2026-10-01T12:00:00.000Z";
function projectedService(id: ServiceId): OrganizationServiceReadiness["services"][number] {
  return { id, configured: true, state: "ready", reason: "health_verified", dependencies: [], checkedAt, lastSuccessAt: checkedAt, stale: false };
}
function capabilities(services = [projectedService("headlessRunner"), projectedService("workbot")]): DeploymentCapabilities {
  return { version: 1, aiGateway: true, serviceReadiness: { version: 2, checkedAt, checking: false, services } };
}

test("the readiness projection is optional and malformed or overprivileged projection fails closed", () => {
  assert.deepEqual(parseDeploymentCapabilities({ version: 1, aiGateway: true }), { version: 1, aiGateway: true });
  const input = capabilities();
  assert.deepEqual(parseDeploymentCapabilities(input), input);
  assert.equal(parseDeploymentCapabilities({ ...input, serviceReadiness: { ...input.serviceReadiness, services: [{ ...projectedService("workbot"), missingSettings: ["DEN_WORKBOT_URL"] }] } }).serviceReadiness, undefined);
  // Removed services (Slack assistant, resumable answers) are not part of the projection.
  assert.equal(parseDeploymentCapabilities({ ...input, serviceReadiness: { ...input.serviceReadiness, services: [{ ...projectedService("workbot"), id: "slack" }] } }).serviceReadiness, undefined);
});

test("a missing projection or healthy services leave the Workbot settings surface unchanged", () => {
  assert.equal(workbotDeploymentNotice({ version: 1, aiGateway: true }), null);
  assert.equal(workbotDeploymentNotice(undefined), null);
  assert.equal(workbotDeploymentNotice(capabilities()), null);
});

test("not checked yet or an older passing check is normal and shows no notice", () => {
  const unchecked: Partial<OrganizationServiceReadiness["services"][number]> = { configured: true, state: "unknown", reason: "not_checked", checkedAt: null, lastSuccessAt: null, stale: true };
  assert.equal(workbotDeploymentNotice(capabilities([{ ...projectedService("headlessRunner"), ...unchecked }, { ...projectedService("workbot"), ...unchecked }])), null);
  assert.equal(workbotDeploymentNotice(capabilities([{ ...projectedService("headlessRunner"), stale: true }, { ...projectedService("workbot"), stale: true }])), null);
});

test("missing Workbot web service does not revoke models used by Slack or Automations", () => {
  const notice = workbotDeploymentNotice(capabilities([{ ...projectedService("workbot"), configured: false, state: "not_configured", reason: "not_configured" }]));
  assert.match(notice?.message ?? "", /deployment administrator/);
  assert.match(notice?.message ?? "", /Model settings for Slack and Automations are still available/);
  assert.doesNotMatch(JSON.stringify(notice), /disabled|DEN_WORKBOT|https:/);
});

test("runner setup and transient failures have recovery copy, timestamps and no authorization semantics", () => {
  const missing = workbotDeploymentNotice(capabilities([{ ...projectedService("headlessRunner"), configured: false, state: "not_configured" }]));
  assert.match(missing?.message ?? "", /Headless runner isn't set up/);
  assert.doesNotMatch(missing?.message ?? "", /are kept/);
  for (const state of ["unreachable", "unknown"] satisfies OrganizationServiceReadiness["services"][number]["state"][]) {
    const notice = workbotDeploymentNotice(capabilities([{ ...projectedService("headlessRunner"), state, reason: "request_failed", stale: true }]));
    assert.match(notice?.message ?? "", /Couldn't verify/);
    assert.match(notice?.message ?? "", /Existing conversations and model settings are kept/);
    assert.equal(notice?.lastSuccessAt, checkedAt);
    assert.equal(notice?.checkedAt, checkedAt);
    assert.equal(notice?.stale, true);
  }
  const failedWorkbot = workbotDeploymentNotice(capabilities([{ ...projectedService("workbot"), state: "unreachable", reason: "request_failed" }]));
  assert.match(failedWorkbot?.message ?? "", /Couldn't verify Workbot/);
  const misconfigured = workbotDeploymentNotice(capabilities([{ ...projectedService("headlessRunner"), state: "misconfigured", reason: "resume_misconfigured" }]));
  assert.match(misconfigured?.message ?? "", /needs a configuration change/);
});

test("timestamps are explicit UTC and never fabricate a successful check", () => {
  assert.equal(formatServiceTime(null), "Not yet");
  assert.equal(formatServiceTime("invalid"), "Not yet");
  assert.match(formatServiceTime(checkedAt), /Oct 1.*12:00 PM UTC/);
});

test("check history is one line and only reports what happened", () => {
  assert.equal(serviceCheckLine({ checkedAt: null, lastSuccessAt: null, stale: true }), null);
  assert.match(serviceCheckLine({ checkedAt, lastSuccessAt: checkedAt, stale: false }) ?? "", /^Last checked Oct 1.*UTC\.$/);
  assert.match(serviceCheckLine({ checkedAt, lastSuccessAt: null, stale: false }) ?? "", /hasn't passed yet/);
  assert.match(serviceCheckLine({ checkedAt: "2026-10-02T12:00:00.000Z", lastSuccessAt: checkedAt, stale: true }) ?? "", /^Out of date\. Last checked Oct 2.*Last worked Oct 1/);
});
