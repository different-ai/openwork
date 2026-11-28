import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentCapabilityStatus } from "@openwork/managed-deployments/capability-state";
import {
  automationsMemberAccess,
  capabilityRows,
  cloudComputersMemberAccess,
  gatewayMemberAccess,
  memberAccessDetail,
  memberAccessLabel,
  slackMemberAccess,
  workbotMemberAccess,
  type Loaded,
  type MemberAccess,
} from "./capabilities-model";

const ready = <T,>(data: T): Loaded<T> => ({ state: "ready", data });
const inherit = { enabled: { inherit: true } } as const;
const teamOn = { enabled: { inherit: false, value: true } } as const;
const teamOff = { enabled: { inherit: false, value: false } } as const;
const everyone: MemberAccess = { kind: "everyone" };
const allEveryone = { workbot: everyone, slackAssistant: everyone, automations: everyone, aiGateway: everyone, cloudComputers: everyone };

const installed: DeploymentCapabilityStatus[] = [
  { id: "workbot", state: "on", reason: "configured" },
  { id: "slackAssistant", state: "off", reason: "switched_off" },
  { id: "automations", state: "on", reason: "configured" },
  { id: "aiGateway", state: "needs_infrastructure", reason: "service_not_installed" },
  { id: "cloudComputers", state: "unsupported", reason: "not_offered" },
];

test("Workbot installed with the organization switch off is not live for members", () => {
  const access = workbotMemberAccess(ready({ organizationEnabled: false, teams: [inherit, inherit] }));
  assert.deepEqual(access, { kind: "off" });
  const [workbot] = capabilityRows(installed, { ...allEveryone, workbot: access });
  assert.equal(workbot?.infrastructure, "Installed");
  assert.equal(workbot?.installedButOff, true);
  assert.equal(workbot?.live, false);
});

test("Workbot access follows the organization switch and each team's own choice", () => {
  assert.deepEqual(workbotMemberAccess(ready({ organizationEnabled: true, teams: [inherit] })), { kind: "everyone" });
  assert.deepEqual(workbotMemberAccess(ready({ organizationEnabled: true, teams: [teamOff, inherit, teamOn] })), { kind: "everyone", detail: "except 1 team" });
  const selected = workbotMemberAccess(ready({ organizationEnabled: false, teams: [teamOn, teamOn, teamOff, inherit] }));
  assert.deepEqual(selected, { kind: "selected", of: "team", count: 2 });
  assert.equal(memberAccessLabel(selected), "Selected teams");
  assert.equal(memberAccessDetail(selected), "2 teams");
});

test("the Slack assistant needs Slack connected, installed and on, and then follows who the connector is shared with", () => {
  const assistant = { installed: true, enabled: true };
  const shared = { orgWide: false, teamCount: 0, memberCount: 0 };
  assert.deepEqual(slackMemberAccess(ready({ connector: null, assistant: null })), { kind: "off", detail: "Slack is not connected" });
  assert.deepEqual(slackMemberAccess(ready({ connector: { ...shared, orgWide: true }, assistant: null })), { kind: "off", detail: "not installed in Slack" });
  assert.deepEqual(slackMemberAccess(ready({ connector: { ...shared, orgWide: true }, assistant: { installed: true, enabled: false } })), { kind: "off", detail: "turned off" });
  assert.deepEqual(slackMemberAccess(ready({ connector: { ...shared, orgWide: true }, assistant })), { kind: "everyone" });
  assert.deepEqual(slackMemberAccess(ready({ connector: { ...shared, teamCount: 3, memberCount: 4 }, assistant })), { kind: "selected", of: "team", count: 3 });
  const members = slackMemberAccess(ready({ connector: { ...shared, memberCount: 1 }, assistant }));
  assert.equal(memberAccessLabel(members), "Selected members");
  assert.equal(memberAccessDetail(members), "1 member");
  assert.deepEqual(slackMemberAccess(ready({ connector: shared, assistant })), { kind: "off", detail: "shared with nobody" });
});

test("Automations are for everyone wherever the organization lets them run", () => {
  assert.deepEqual(automationsMemberAccess(ready({ desktop: true, cloud: true })), { kind: "everyone" });
  assert.deepEqual(automationsMemberAccess(ready({ desktop: true, cloud: false })), { kind: "everyone", detail: "on desktop only" });
  assert.deepEqual(automationsMemberAccess(ready({ desktop: false, cloud: true })), { kind: "everyone", detail: "in the cloud only" });
  assert.deepEqual(automationsMemberAccess(ready({ desktop: false, cloud: false })), { kind: "off" });
});

test("AI Gateway access is the widest audience a usable model group is shared with", () => {
  assert.deepEqual(gatewayMemberAccess(ready({ grants: [] })), { kind: "off", detail: "no models shared" });
  assert.deepEqual(gatewayMemberAccess(ready({ grants: [{ audience: "team", subjectId: "team_a" }, { audience: "organization", subjectId: null }] })), { kind: "everyone" });
  assert.deepEqual(gatewayMemberAccess(ready({ grants: [{ audience: "team", subjectId: "team_a" }, { audience: "team", subjectId: "team_a" }, { audience: "team", subjectId: "team_b" }, { audience: "member", subjectId: "member_a" }] })), { kind: "selected", of: "team", count: 2 });
  assert.deepEqual(gatewayMemberAccess(ready({ grants: [{ audience: "member", subjectId: "member_a" }] })), { kind: "selected", of: "member", count: 1 });
});

test("cloud computers are used from Workbot, so they follow its access", () => {
  const workbot: MemberAccess = { kind: "selected", of: "team", count: 2 };
  assert.equal(cloudComputersMemberAccess(workbot), workbot);
});

test("a source that is loading, locked or failed never reads as Off or Everyone", () => {
  const sources: Array<[Loaded<{ desktop: boolean; cloud: boolean }>, MemberAccess]> = [
    [{ state: "loading" }, { kind: "loading" }],
    [{ state: "locked", reason: "Needs the Manage AI Gateway permission" }, { kind: "locked", reason: "Needs the Manage AI Gateway permission" }],
    [{ state: "error", reason: "Couldn't load Automations settings." }, { kind: "unknown", reason: "Couldn't load Automations settings." }],
  ];
  for (const [source, expected] of sources) assert.deepEqual(automationsMemberAccess(source), expected);
  assert.equal(memberAccessLabel({ kind: "loading" }), "Checking");
  assert.equal(memberAccessLabel({ kind: "locked", reason: "x" }), "Locked");
  assert.equal(memberAccessDetail({ kind: "unknown", reason: "Couldn't load." }), "Couldn't load.");
  const [workbot] = capabilityRows(installed, { ...allEveryone, workbot: { kind: "loading" } });
  assert.equal(workbot?.live, false);
  assert.equal(workbot?.installedButOff, false);
});

test("rows keep the catalog order, name each infrastructure state and say why", () => {
  const rows = capabilityRows(installed, allEveryone);
  assert.deepEqual(rows.map((row) => [row.label, row.infrastructure]), [
    ["Workbot", "Installed"],
    ["Slack assistant", "Off"],
    ["Automations", "Installed"],
    ["AI Gateway", "Needs installation"],
    ["Cloud computers", "Not available"],
  ]);
  assert.equal(rows[3]?.reason, "Its service is not installed in this deployment yet.");
  assert.deepEqual(rows.map((row) => row.live), [true, false, true, false, false], "access for everyone is not live without the infrastructure");
  assert.deepEqual(rows.map((row) => row.access.kind), ["everyone", "everyone", "everyone", "not_applicable", "not_applicable"], "there is nothing to grant until it is installed");
  assert.equal(rows[3]?.installedButOff, false);
  assert.deepEqual(capabilityRows(installed.slice(0, 2), allEveryone).map((row) => row.id), ["workbot", "slackAssistant"], "a capability the server did not report is left out");
});
