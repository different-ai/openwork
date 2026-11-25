import assert from "node:assert/strict";
import { test } from "node:test";
import type { InstallationConfig } from "@openwork/types/den/diagnostics";
import {
  installationConfigExportText,
  installationConfigFileName,
  installationConfigOf,
  installationVersionState,
  parseOrgDiagnostics,
} from "./diagnostics-data";
import { lockedReport, report, services } from "./diagnostics-test-fixtures";

const config: InstallationConfig = {
  appVersion: "0.19.2",
  helmChartVersion: "0.2.0",
  helmAppVersion: "0.19.1",
  versionSkew: true,
  deploymentCapabilities: [
    { id: "workbot", state: "on", reason: "configured" },
    { id: "aiGateway", state: "needs_infrastructure", reason: "service_not_installed" },
  ],
  lockedFeatures: { administratorRecovery: true },
};

function operatorReport(installationConfig?: InstallationConfig) {
  return report({
    installation: {
      access: "operator",
      server: { version: "0.19.2", startedAt: "2026-10-20T13:00:00.000Z", startupMs: 4_100 },
      services: services(),
      ...(installationConfig ? { config: installationConfig } : {}),
    },
  });
}

test("a report with or without the installation configuration is accepted", () => {
  assert.deepEqual(parseOrgDiagnostics(operatorReport(config)), operatorReport(config));
  assert.deepEqual(parseOrgDiagnostics(operatorReport()), operatorReport());
});

test("only an installation administrator's report carries a configuration", () => {
  assert.deepEqual(installationConfigOf(operatorReport(config)), config);
  assert.equal(installationConfigOf(operatorReport()), null);
  assert.equal(installationConfigOf(lockedReport()), null);
  assert.equal(installationConfigOf(report({ installation: { access: "locked", reason: "installation_admin_required" } })), null);
  assert.equal(installationConfigExportText(lockedReport()), null);
});

test("the exported file holds the configuration and when it was read, and nothing else from the report", () => {
  const text = installationConfigExportText(operatorReport(config));
  assert.ok(text);
  assert.deepEqual(JSON.parse(text), {
    kind: "openwork.installation-config",
    version: 1,
    generatedAt: "2026-10-20T16:00:00.000Z",
    deployment: "self_hosted",
    ...config,
  });
  assert.doesNotMatch(text, /LiteLLM|startedAt|DEN_HEADLESS_RUNNER_URL|certificate|claude/);
  assert.equal(installationConfigFileName(operatorReport(config)), "openwork-installation-config-2026-10-20.json");
});

test("the version badge warns on a mismatch, confirms a match, and stays silent without a chart version", () => {
  assert.equal(installationVersionState(config), "mismatch");
  assert.equal(installationVersionState({ ...config, helmAppVersion: "0.19.2", versionSkew: false }), "match");
  assert.equal(installationVersionState({ appVersion: "dev", versionSkew: false, deploymentCapabilities: [], lockedFeatures: {} }), "unknown");
});
