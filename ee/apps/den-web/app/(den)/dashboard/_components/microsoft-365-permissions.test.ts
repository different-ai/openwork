import assert from "node:assert/strict";
import { test } from "node:test";
import { MICROSOFT_365_FEATURES } from "@openwork/types/den/microsoft-365";
import { visibleNativePermissionGroups } from "./google-workspace-permissions";
import { MICROSOFT_365_DEFAULT_FEATURES, MICROSOFT_365_DISPLAY_SCOPES, MICROSOFT_365_PERMISSION_GROUPS } from "./microsoft-365-permissions";

const keys = (groups: readonly { permissions: readonly { key: string }[] }[]) => groups.flatMap((group) => group.permissions.map((permission) => permission.key));

test("every Microsoft 365 permission is offered once and the transcript permission is opt-in", () => {
  assert.deepEqual([...keys(MICROSOFT_365_PERMISSION_GROUPS)].sort(), [...MICROSOFT_365_FEATURES].sort());
  assert.equal(MICROSOFT_365_DEFAULT_FEATURES.some((feature) => feature === "teamsTranscriptRead"), false);
  const teams = MICROSOFT_365_PERMISSION_GROUPS.find((group) => group.name === "Teams");
  const transcript = teams?.permissions.find((permission) => permission.key === "teamsTranscriptRead");
  assert.equal(transcript?.requiresFeature, "teamsMeetingTranscripts");
  assert.match(transcript?.detail ?? "", /admin consent/);
  for (const scope of ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]) assert.equal(MICROSOFT_365_DISPLAY_SCOPES.has(scope), true, scope);
});

test("the transcript permission shows only with its feature on, or when it is already selected so it can be cleared", () => {
  const off = keys(visibleNativePermissionGroups(MICROSOFT_365_PERMISSION_GROUPS, () => false, ["mailRead"]));
  assert.equal(off.includes("teamsTranscriptRead"), false);
  assert.deepEqual(off, keys(MICROSOFT_365_PERMISSION_GROUPS).filter((key) => key !== "teamsTranscriptRead"));
  const on = keys(visibleNativePermissionGroups(MICROSOFT_365_PERMISSION_GROUPS, (key) => key === "teamsMeetingTranscripts", []));
  assert.deepEqual(on, keys(MICROSOFT_365_PERMISSION_GROUPS));
  const saved = keys(visibleNativePermissionGroups(MICROSOFT_365_PERMISSION_GROUPS, () => false, ["teamsTranscriptRead"]));
  assert.equal(saved.includes("teamsTranscriptRead"), true);
});
