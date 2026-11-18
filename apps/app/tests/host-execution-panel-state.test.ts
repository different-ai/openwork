import { expect, test } from "bun:test";
import type { OpenworkSandboxSettingsResponse } from "../src/app/lib/openwork-server";
import { canPrepareSandbox, canRetrySandbox, hostExecutionRow, sandboxRuntimeStatus, withOwnHostExecutionSetting } from "../src/react-app/domains/settings/panels/host-execution-panel-state";
import { sandboxSettingsPollInterval } from "../src/react-app/infra/use-sandbox-settings";

const allowed: OpenworkSandboxSettingsResponse = { allowHostExecution: true, effectiveAllowHostExecution: true, managed: false, featureEnabled: true };
const isolated: OpenworkSandboxSettingsResponse = { ...allowed, allowHostExecution: false, effectiveAllowHostExecution: false };

test("flag off hides every section state without changing policy", () => {
  for (const settings of [null, allowed, isolated, { ...isolated, managed: true }, { ...isolated, pending: true }]) {
    expect(hostExecutionRow(settings, false).visible).toBe(false);
  }
  expect(hostExecutionRow(null, true).visible).toBe(true);
  expect(hostExecutionRow(isolated, false).hostToolsAllowed).toBe(false);
});

test("managed policy locks either selected location to effective rather than own preference", () => {
  for (const effectiveAllowHostExecution of [false, true]) {
    const settings = { ...allowed, managed: true, allowHostExecution: !effectiveAllowHostExecution, effectiveAllowHostExecution };
    const row = hostExecutionRow(settings, true);
    expect(row.lockedByOrganization).toBe(true);
    expect(row.desiredHostToolsAllowed).toBe(effectiveAllowHostExecution);
    expect(withOwnHostExecutionSetting(settings, !effectiveAllowHostExecution)).toEqual(settings);
  }
});

test("pending locations preserve current execution and label sandbox folders in either direction", () => {
  for (const current of [true, false]) {
    const settings = { ...allowed, allowHostExecution: !current, effectiveAllowHostExecution: current, pending: true };
    const row = hostExecutionRow(settings, true);
    expect(row.desiredHostToolsAllowed).toBe(!current);
    expect(row.hostToolsAllowed).toBe(current);
    expect(row.sandboxFolders).toBe(true);
    expect(row.note).toBe(current ? "pending_host" : "pending_sandbox");
  }
  expect(withOwnHostExecutionSetting(allowed, false)).toEqual({ ...allowed, allowHostExecution: false, pending: true });
});

test("runtime state table does not invent readiness for an older server", () => {
  expect(sandboxRuntimeStatus(isolated)).toBeNull();
  for (const state of ["idle", "starting", "ready", "unsupported", "failed"] satisfies NonNullable<OpenworkSandboxSettingsResponse["runtime"]>["state"][]) {
    const settings = { ...isolated, runtime: { state, canRetry: true } };
    expect(sandboxRuntimeStatus(settings)).toBe(state);
    expect(canPrepareSandbox(settings)).toBe(state === "idle");
    expect(canRetrySandbox(settings)).toBe(state === "failed" || state === "unsupported");
    expect(sandboxSettingsPollInterval(settings)).toBe(state === "starting" || state === "idle" ? 1_000 : 5_000);
    expect(canPrepareSandbox({ ...settings, pending: true })).toBe(false);
    expect(canRetrySandbox({ ...settings, pending: true })).toBe(false);
    expect(canRetrySandbox({ ...settings, effectiveAllowHostExecution: true })).toBe(false);
  }
  expect(sandboxSettingsPollInterval({ ...allowed, pending: true })).toBe(1_000);
  expect(sandboxRuntimeStatus({ ...isolated, featureEnabled: false })).toBe("unsupported");
});
