import assert from "node:assert/strict";
import { test } from "node:test";
import { accessForTool, defaultToolAccess, everyoneLabel, rulesForSubject, toolActivityLabel, withPendingRule, type PermissionRule } from "./model";

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

test("a pending edit replaces or removes only the chosen rule, without changing confirmed rules", () => {
  const confirmed = [orgRule("allow"), rule(team, "ask")];
  const target = { subject: team, connectionId, toolName };
  assert.equal(accessForTool(toolName, "allow", rulesOf(withPendingRule(confirmed, { ...target, rule: "block" }))).access, "block");
  assert.equal(accessForTool(toolName, "allow", rulesOf(withPendingRule(confirmed, { ...target, rule: null }))).access, "allow");
  assert.equal(accessForTool(toolName, "allow", rulesOf(withPendingRule(confirmed))).access, "ask");
});
