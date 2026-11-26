import assert from "node:assert/strict";
import { test } from "node:test";
import type { PersonalAgentAudience, PersonalAgentEventDetail, PersonalAgentShare } from "@openwork/types/den/personal-agents";
import { agentAccess, agentEventSentence, formatAgentMoney, writeAccessText } from "./words";

const agent = "Bug watcher";
const cases: readonly [string, PersonalAgentEventDetail, string][] = [
  ["agent.created", {}, "created Bug watcher"],
  ["agent.updated", {}, "updated Bug watcher"],
  ["agent.archived", {}, "archived Bug watcher"],
  ["agent.paused", {}, "paused Bug watcher"],
  ["agent.resumed", {}, "resumed Bug watcher"],
  ["agent.transferred", { from: "Dana Reyes", to: "Sam Okafor" }, "moved Bug watcher from Dana Reyes to Sam Okafor"],
  ["agent.budget_set", { monthlyBudgetMicros: 10_000_000 }, "set Bug watcher's budget to $10.00 a month"],
  ["agent.budget_set", { monthlyBudgetMicros: 0 }, "set Bug watcher's budget to $0.00 a month"],
  ["agent.budget_set", { monthlyBudgetMicros: null }, "removed Bug watcher's budget"],
  ["agent.tools_changed", {}, "changed the tools Bug watcher may use"],
  ["share.added", { member: "Priya Nair", role: "collaborator" }, "shared Bug watcher with Priya Nair as Collaborator"],
  ["share.changed", { memberName: "Sam Okafor", role: "manager" }, "changed Sam Okafor's role on Bug watcher to Manager"],
  ["share.changed", { what: "shared_login", connection: "Linear", on: true }, "shared their Linear login with Bug watcher"],
  ["share.changed", { what: "shared_login", connection: "Linear", on: false }, "stopped sharing their Linear login with Bug watcher"],
  ["share.changed", { organization: false, teams: 0 }, "changed who can use Bug watcher"],
  ["share.changed", { teams: 2 }, "changed who can use Bug watcher"],
  ["share.removed", { member: "Priya Nair" }, "removed Priya Nair's access to Bug watcher"],
  ["routine.created", { routineName: "Morning check" }, "added Morning check to Bug watcher"],
  ["routine.changed", { routineName: "Morning check" }, "changed Morning check on Bug watcher"],
  ["request.asked", { tool: "Create issue" }, "asked to let Bug watcher use Create issue"],
  ["request.asked", { summary: "Change the schedule" }, "asked to change Bug watcher"],
  ["request.asked", { kind: "change", summary: "Change the schedule", tool: "Not a tool" }, "asked to change Bug watcher"],
  ["request.denied", { tool: "Create issue" }, "denied Bug watcher access to Create issue"],
  ["request.denied", { summary: "Change the schedule" }, "denied a request to change Bug watcher"],
  ["request.allowed_once", { tool: "Create issue" }, "let Bug watcher use Create issue once"],
  ["request.always_allowed", { tool: "Create issue" }, "let Bug watcher always use Create issue"],
  ["request.approved", { summary: "Change the schedule" }, "approved a change to Bug watcher"],
  ["organization.sharing_changed", { shareMode: "everyone" }, "let everyone share agents"],
  ["organization.sharing_changed", { shareMode: "admins" }, "limited sharing agents to admins"],
  ["organization.shared_logins_changed", { on: true }, "allowed shared logins"],
  ["organization.shared_logins_changed", { on: false }, "turned shared logins off"],
  ["organization.rules_changed", { rules: "A private rule" }, "changed the rules every agent follows"],
  ["organization.tools_changed", { what: "sharing", shareMode: "everyone" }, "let everyone share agents"],
  ["organization.tools_changed", { what: "sharing", shareMode: "admins" }, "limited sharing agents to admins"],
  ["organization.tools_changed", { what: "shared_logins", on: true }, "allowed shared logins"],
  ["organization.tools_changed", { what: "shared_logins", on: false }, "turned shared logins off"],
  ["organization.tools_changed", { what: "rules" }, "changed the rules every agent follows"],
  ["organization.tools_changed", { what: "tools" }, "changed the tool rules for every agent"],
  ["organization.tools_changed", {}, "changed the tool rules for every agent"],
  ["organization.budget_set", { monthlyBudgetMicros: 50_000_000 }, "set the spending limit for every agent to $50.00 a month"],
  ["organization.budget_set", { monthlyBudgetMicros: null }, "removed the spending limit for every agent"],
  ["agent.future_action", {}, "recorded agent future action"],
];

for (const [action, detail, expected] of cases) {
  test(`words for ${expected}`, () => {
    assert.equal(agentEventSentence(action, detail, action.startsWith("organization.") ? null : agent), expected);
  });
}

const noAudience: PersonalAgentAudience = { organization: false, autoAddOrganization: false, teams: [] };
const people: PersonalAgentShare[] = [
  { memberId: "sam", name: "Sam Okafor", role: "manager", createdAt: 0 },
  { memberId: "priya", name: "Priya Nair", role: "collaborator", createdAt: 0 },
  { memberId: "lee", name: "Lee Park", role: "collaborator", createdAt: 0 },
];
const teams = [{ teamId: "support", name: "Support", autoAdd: true }, { teamId: "design", name: "Design", autoAdd: false }];

function access(audience: PersonalAgentAudience, sharedWith: PersonalAgentShare[] = []) {
  return agentAccess({ audience, sharedWith }, "Acme");
}

test("access is Not shared with no audience and no people", () => {
  assert.deepEqual(access(noAudience), { text: "Not shared", notShared: true, addedToSidebar: false });
});

test("everyone takes precedence in the access text", () => {
  assert.deepEqual(access({ organization: true, autoAddOrganization: true, teams }, people),
    { text: "Everyone in Acme", notShared: false, addedToSidebar: true });
  assert.equal(access({ ...noAudience, organization: true }).addedToSidebar, false);
});

test("access names teams and people with roles", () => {
  assert.deepEqual(access({ ...noAudience, teams }), { text: "Support, Design", notShared: false, addedToSidebar: true });
  assert.equal(access({ ...noAudience, teams }, people.slice(0, 1)).text, "Support, Design, Sam Okafor (Manager)");
  assert.equal(access(noAudience, people).text, "Sam Okafor (Manager), Priya Nair (Collaborator), Lee Park (Collaborator)");
});

test("access collapses more than three entries to counts", () => {
  assert.equal(access({ ...noAudience, teams }, people).text, "2 teams, 3 people");
  assert.equal(access(noAudience, [...people, { memberId: "dana", name: "Dana Reyes", role: "manager", createdAt: 0 }]).text, "4 people");
});

test("write access shows the default or each count", () => {
  assert.equal(writeAccessText({ allowed: 0, ask: 0, blocked: 0 }), "Asks first");
  assert.equal(writeAccessText({ allowed: 3, ask: 0, blocked: 2 }), "3 allowed · 0 ask · 2 blocked");
});

test("money converts micros into two decimal places", () => {
  assert.equal(formatAgentMoney(0), "$0.00");
  assert.equal(formatAgentMoney(424_999), "$0.42");
  assert.equal(formatAgentMoney(425_000), "$0.43");
  assert.equal(formatAgentMoney(10_000_000), "$10.00");
  assert.equal(formatAgentMoney(1_250_500_000), "$1,250.50");
});
