import assert from "node:assert/strict";
import { test } from "node:test";
import { MICROSOFT_365_DEFAULT_FEATURES, MICROSOFT_365_FEATURES } from "@openwork/types/den/microsoft-365";
import { visibleNativePermissionGroups } from "./google-workspace-permissions";
import { MICROSOFT_365_DISPLAY_SCOPES, MICROSOFT_365_PERMISSION_GROUPS } from "./microsoft-365-permissions";

const optIn = ["directoryRead", "teamsChannelList"];

test("Microsoft 365 offers each connector permission exactly once with all new scopes and unchanged defaults", () => {
  const keys = MICROSOFT_365_PERMISSION_GROUPS.flatMap((group) => group.permissions.map(({ key }) => key));
  assert.deepEqual(keys.sort(), [...MICROSOFT_365_FEATURES].sort());
  assert.equal(MICROSOFT_365_DEFAULT_FEATURES.some((key) => optIn.includes(key)), false);
  for (const scope of ["User.ReadBasic.All", "Team.ReadBasic.All", "Channel.ReadBasic.All"]) {
    assert.ok(MICROSOFT_365_DISPLAY_SCOPES.has(scope));
  }
});

test("the rollout gates new permissions but lets admins clear a selected permission when off", () => {
  const off = visibleNativePermissionGroups(MICROSOFT_365_PERMISSION_GROUPS, () => false, []);
  assert.equal(off.some(({ name }) => name === "People"), false);
  assert.equal(off.flatMap(({ permissions }) => permissions).some(({ key }) => optIn.includes(key)), false);
  const on = visibleNativePermissionGroups(MICROSOFT_365_PERMISSION_GROUPS, (key) => key === "microsoft365ReadResources", []);
  const shown = on.flatMap(({ permissions }) => permissions.map(({ key }) => key));
  assert.deepEqual(shown, MICROSOFT_365_PERMISSION_GROUPS.flatMap(({ permissions }) => permissions.map(({ key }) => key)).filter((key) => key !== "teamsTranscriptRead"));
  const both = visibleNativePermissionGroups(MICROSOFT_365_PERMISSION_GROUPS, (key) => key === "microsoft365ReadResources" || key === "teamsMeetingTranscripts", []);
  assert.deepEqual(both, MICROSOFT_365_PERMISSION_GROUPS);
  const selected = visibleNativePermissionGroups(MICROSOFT_365_PERMISSION_GROUPS, () => false, ["directoryRead"]);
  assert.deepEqual(selected.flatMap(({ permissions }) => permissions.map(({ key }) => key)).filter((key) => optIn.includes(key)), ["directoryRead"]);
});
