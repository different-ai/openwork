import { expect, test } from "bun:test";
import { createOpenworkServerClient, type OpenworkSandboxSettingsResponse } from "../src/app/lib/openwork-server";
import { sandboxSettingsPollInterval, sandboxSettingsQueryKey } from "../src/react-app/infra/use-sandbox-settings";

const computer: OpenworkSandboxSettingsResponse = { allowHostExecution: true, effectiveAllowHostExecution: true, managed: false, featureEnabled: true };

test("shared polling reserves one-second reads for pending or preparing sandbox execution", () => {
  for (const effectiveAllowHostExecution of [true, false]) {
    for (const state of ["idle", "starting", "ready", "failed", "unsupported"] satisfies NonNullable<OpenworkSandboxSettingsResponse["runtime"]>["state"][]) {
      const settings = { ...computer, effectiveAllowHostExecution, runtime: { state, canRetry: false } };
      expect(sandboxSettingsPollInterval(settings)).toBe(!effectiveAllowHostExecution && (state === "idle" || state === "starting") ? 1_000 : 5_000);
      expect(sandboxSettingsPollInterval({ ...settings, pending: true })).toBe(1_000);
    }
  }
  expect(sandboxSettingsPollInterval(computer)).toBe(5_000);
  expect(sandboxSettingsPollInterval({ ...computer, featureEnabled: false })).toBe(5_000);
  expect(sandboxSettingsPollInterval(null)).toBe(false);
  expect(sandboxSettingsPollInterval(undefined)).toBe(false);
});

test("shared cache isolates servers and workspaces without placing credentials in keys", () => {
  const first = createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "fixture-private" });
  const second = createOpenworkServerClient({ baseUrl: "http://localhost:8788", token: "fixture-private" });
  expect(sandboxSettingsQueryKey(first, "workspace-one")).not.toEqual(sandboxSettingsQueryKey(second, "workspace-one"));
  expect(sandboxSettingsQueryKey(first, "workspace-one")).not.toEqual(sandboxSettingsQueryKey(first, "workspace-two"));
  expect(sandboxSettingsQueryKey(first, "workspace-one")).toEqual(["openwork-server", first.baseUrl, "sandbox-settings", "workspace-one"]);
  expect(JSON.stringify(sandboxSettingsQueryKey(first, "workspace-one"))).not.toContain("fixture-private");
});
