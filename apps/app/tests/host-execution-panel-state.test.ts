import { expect, test } from "bun:test";
import { hostExecutionRow, withOwnHostExecutionSetting } from "../src/react-app/domains/settings/panels/host-execution-panel-state.ts";

const allowed = { allowHostExecution: true, effectiveAllowHostExecution: true, managed: false, featureEnabled: true };

test("the row is offered with the rollout on and hidden without it while host tools are allowed", () => {
  expect(hostExecutionRow(allowed, true)).toEqual({ visible: true, hostToolsAllowed: true, desiredHostToolsAllowed: true, lockedByOrganization: false, note: null });
  expect(hostExecutionRow({ ...allowed, featureEnabled: false }, false).visible).toBe(false);
  expect(hostExecutionRow(null, true).visible).toBe(false);
});

test("the member's own Off is editable and explains sandbox-only", () => {
  const settings = { ...allowed, allowHostExecution: false, effectiveAllowHostExecution: false };
  expect(hostExecutionRow(settings, true)).toEqual({ visible: true, hostToolsAllowed: false, desiredHostToolsAllowed: false, lockedByOrganization: false, note: "sandbox_only" });
});

test("the organization's requirement locks the row whatever the member chose", () => {
  for (const allowHostExecution of [true, false]) {
    const settings = { allowHostExecution, effectiveAllowHostExecution: false, managed: true, featureEnabled: true };
    expect(hostExecutionRow(settings, true)).toEqual({ visible: true, hostToolsAllowed: false, desiredHostToolsAllowed: false, lockedByOrganization: true, note: "managed" });
  }
});

test("losing the rollout keeps a standing requirement on screen instead of restoring host tools", () => {
  const own = { allowHostExecution: false, effectiveAllowHostExecution: false, managed: false, featureEnabled: false };
  expect(hostExecutionRow(own, false)).toEqual({ visible: true, hostToolsAllowed: false, desiredHostToolsAllowed: false, lockedByOrganization: false, note: "sandbox_unavailable" });
  expect(hostExecutionRow({ ...own, managed: true }, false)).toEqual({ visible: true, hostToolsAllowed: false, desiredHostToolsAllowed: false, lockedByOrganization: true, note: "managed" });
  expect(hostExecutionRow(own, true).note).toBe("sandbox_unavailable");
});

test("the saved toggle and effective policy stay distinct while either direction is pending", () => {
  expect(hostExecutionRow({ ...allowed, allowHostExecution: false, pending: true }, true)).toEqual({
    visible: true, hostToolsAllowed: true, desiredHostToolsAllowed: false, lockedByOrganization: false, note: "pending_host",
  });
  expect(hostExecutionRow({ ...allowed, effectiveAllowHostExecution: false, pending: true }, true)).toEqual({
    visible: true, hostToolsAllowed: false, desiredHostToolsAllowed: true, lockedByOrganization: false, note: "pending_sandbox",
  });
});

test("the switch moves at once without falsely reporting that the process already changed", () => {
  expect(withOwnHostExecutionSetting(allowed, false)).toEqual({ ...allowed, allowHostExecution: false, pending: true });
  const managed = { allowHostExecution: false, effectiveAllowHostExecution: false, managed: true, featureEnabled: true };
  expect(withOwnHostExecutionSetting(managed, true).effectiveAllowHostExecution).toBe(false);
});
