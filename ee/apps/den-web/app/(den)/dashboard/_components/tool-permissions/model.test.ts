import assert from "node:assert/strict";
import { test } from "node:test";
import { accessForTool, defaultToolAccess, everyoneLabel, rulesForSubject, toolActivityLabel, toolRowAccess, withPendingRule, type PermissionRule } from "./model";

const organization = { kind: "organization" } as const;
const team = { kind: "team", id: "support" } as const;
const person = { kind: "member", id: "priya" } as const;
const connectionId = "issue-board";
const toolName = "UpdateIssue";

function rule(subject: PermissionRule["subject"], rule: PermissionRule["rule"], name = toolName, connection = connectionId): PermissionRule {
  return { subject, rule, toolName: name, connectionId: connection };
}

function orgRule(access: PermissionRule["rule"], name = toolName) {
  return rule({ ...organization, id: null }, access, name);
}

function rulesOf(rules: readonly PermissionRule[]) {
  return [organization, team, person].map((subject) => rulesForSubject(rules, connectionId, subject));
}

test("a tool reads only with an explicit read hint and no destructive hint", () => {
  assert.equal(defaultToolAccess({ readOnlyHint: true }), "allow");
  assert.equal(toolActivityLabel({ readOnlyHint: true, destructiveHint: false }), "reads");
  assert.equal(defaultToolAccess({ readOnlyHint: true, destructiveHint: true }), "ask");
  assert.equal(toolActivityLabel({ readOnlyHint: true, destructiveHint: true }), "changes things");
  assert.equal(defaultToolAccess(), "ask");
  assert.equal(defaultToolAccess({ readOnlyHint: false }), "ask");
});

test("block wins over ask, and ask wins over allow across audience layers", () => {
  const allow = rule(person, "allow");
  assert.equal(accessForTool(toolName, "ask", rulesOf([allow])).access, "allow");
  assert.equal(accessForTool(toolName, "allow", rulesOf([orgRule("ask"), allow])).access, "ask");
  assert.equal(accessForTool(toolName, "allow", rulesOf([orgRule("ask"), rule(team, "block"), allow])).access, "block");
  assert.equal(accessForTool(toolName, "allow", rulesOf([orgRule("block", "*"), allow])).access, "block");
  assert.equal(accessForTool(toolName, "allow", rulesOf([orgRule("allow"), rule(team, "block", "*")])).access, "block");
});

test("rules are scoped to the exact connection, audience and tool name", () => {
  const rules = [rule(team, "block", toolName, "another-board"), rule({ kind: "team", id: "other-team" }, "block"), orgRule("block", "updateissue")];
  assert.deepEqual(accessForTool(toolName, "allow", rulesOf(rules)), { rule: null, access: "allow" });
});

test("Everyone labels distinguish inherited rules, defaults and unknown tool behavior", () => {
  assert.equal(everyoneLabel(accessForTool(toolName, "ask", rulesOf([]))), "Everyone: Ask (default)");
  assert.equal(everyoneLabel(accessForTool(toolName, "ask", rulesOf([orgRule("ask")]))), "Everyone: Ask");
  assert.equal(everyoneLabel(accessForTool(toolName, null, rulesOf([]))), "Everyone: No rule");
  assert.equal(everyoneLabel(accessForTool(toolName, null, rulesOf([orgRule("block", "*")]))), "Everyone: Block");
});

function row(rules: readonly PermissionRule[], subject: typeof organization | typeof team | typeof person, fallback: PermissionRule["rule"] | null = "ask") {
  return toolRowAccess({
    toolName,
    fallback,
    ownRules: rulesForSubject(rules, connectionId, subject),
    orgRules: rulesForSubject(rules, connectionId, organization),
    memberTeamRules: subject.kind === "member" ? [rulesForSubject(rules, connectionId, team)] : [],
    everyoneSelected: subject.kind === "organization",
  });
}

test("Everyone's Default is built in, even with an explicit rule", () => {
  assert.equal(row([], organization, "allow").defaultLabel, "Default (Allow)");
  assert.equal(row([orgRule("block")], organization).defaultLabel, "Default (Ask)");
  assert.equal(row([orgRule("block")], organization, null).defaultLabel, "Default");
  assert.equal(row([orgRule("block")], organization).notice, null);
});

test("team and person defaults ignore their own rules and use applicable inherited layers", () => {
  const rules = [orgRule("allow"), rule(team, "ask"), rule(person, "block")];
  assert.equal(row(rules, team).defaultLabel, "Default (Allow)");
  assert.equal(row(rules, person).defaultLabel, "Default (Ask)");
  assert.equal(row([orgRule("block"), ...rules.slice(1)], person).defaultLabel, "Default (Block)");
  assert.equal(row([orgRule("ask"), rule(team, "block", "*")], person).defaultLabel, "Default (Block)");
  assert.equal(row([], team).defaultLabel, "Default (Ask)");
  assert.equal(row([orgRule("ask")], team, null).defaultLabel, "Default");
});

test("the pressed segment is the audience's own rule, or Default after removal", () => {
  assert.equal(row([orgRule("allow")], organization, "allow").pressed, "allow");
  assert.equal(row([orgRule("block")], team).pressed, "default");
  const rules = [orgRule("ask"), rule(person, "allow")];
  assert.equal(row(rules, person).pressed, "allow");
  const cleared = withPendingRule(rules, { subject: person, connectionId, toolName, rule: null });
  assert.equal(row(cleared, person).pressed, "default");
});

test("the secondary line reports an override only when Everyone's rule wins over the saved choice", () => {
  assert.deepEqual(row([orgRule("block"), rule(team, "allow")], team).notice, {
    label: "Everyone: Block", overrideLabel: "Everyone: Block. This rule waits until that changes.", overridden: true,
  });
  assert.equal(row([orgRule("ask"), rule(person, "allow")], person).notice?.overridden, true);
  assert.deepEqual(row([orgRule("ask"), rule(person, "block")], person).notice, {
    label: "Everyone: Ask", overrideLabel: "Everyone: Ask. This rule waits until that changes.", overridden: false,
  });
  assert.equal(row([orgRule("ask"), rule(person, "ask")], person).notice?.overridden, false);
  assert.equal(row([orgRule("ask")], person).notice?.overridden, false);
  assert.equal(row([orgRule("ask"), rule(team, "block"), rule(person, "allow")], person).notice?.overridden, false);
});

test("locks keep the selected segment while reporting which block needs changing", () => {
  const locked = row([orgRule("block"), rule(team, "allow")], team);
  assert.equal(locked.pressed, "allow");
  assert.equal(locked.lockReason, "Blocked for everyone. An admin can change this under Everyone.");
  assert.equal(row([orgRule("block")], organization).lockReason, null);
  assert.equal(row([orgRule("block", "*")], organization).lockReason, "Turn off the whole connection block to change this.");
  assert.equal(row([rule(team, "block", "*")], person).lockReason, "Blocked by a team. An admin can change this under that team.");
});

test("a pending edit replaces or removes only the chosen rule, without changing confirmed rules", () => {
  const confirmed = [orgRule("allow"), rule(team, "ask")];
  const target = { subject: team, connectionId, toolName };
  assert.equal(accessForTool(toolName, "allow", rulesOf(withPendingRule(confirmed, { ...target, rule: "block" }))).access, "block");
  assert.equal(accessForTool(toolName, "allow", rulesOf(withPendingRule(confirmed, { ...target, rule: null }))).access, "allow");
  assert.equal(accessForTool(toolName, "allow", rulesOf(withPendingRule(confirmed))).access, "ask");
});
