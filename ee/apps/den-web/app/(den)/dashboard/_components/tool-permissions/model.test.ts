import assert from "node:assert/strict";
import { test } from "node:test";
import { accessForTool, rulesForSubject, toolActivityLabel, toolRowAccess, withPendingRule, type PermissionRule } from "./model";

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
  assert.equal(toolActivityLabel({ readOnlyHint: true, destructiveHint: false }), "reads");
  assert.equal(toolActivityLabel({ readOnlyHint: true, destructiveHint: true }), "changes things");
});

test("block wins over ask, and ask wins over allow across audience layers", () => {
  const allow = rule(person, "allow");
  assert.equal(accessForTool(toolName, rulesOf([allow])).access, "allow");
  assert.equal(accessForTool(toolName, rulesOf([orgRule("ask"), allow])).access, "ask");
  assert.equal(accessForTool(toolName, rulesOf([orgRule("ask"), rule(team, "block"), allow])).access, "block");
  assert.equal(accessForTool(toolName, rulesOf([orgRule("block", "*"), allow])).access, "block");
  assert.equal(accessForTool(toolName, rulesOf([orgRule("allow"), rule(team, "block", "*")])).access, "block");
});

test("rules are scoped to the exact connection, audience and tool name", () => {
  const rules = [rule(team, "block", toolName, "another-board"), rule({ kind: "team", id: "other-team" }, "block"), orgRule("block", "updateissue")];
  assert.deepEqual(accessForTool(toolName, rulesOf(rules)), { rule: null, access: "allow" });
});

function row(rules: readonly PermissionRule[], subject: typeof organization | typeof team | typeof person) {
  return toolRowAccess({
    toolName,
    ownRules: rulesForSubject(rules, connectionId, subject),
    orgRules: rulesForSubject(rules, connectionId, organization),
    memberTeams: subject.kind === "member" ? [{ name: "Support", rules: rulesForSubject(rules, connectionId, team) }] : [],
    everyoneSelected: subject.kind === "organization",
  });
}

test("Everyone's Default is built in, even with an explicit rule", () => {
  assert.equal(row([], organization).defaultLabel, "Allowed (no rule)");
  assert.equal(row([orgRule("block")], organization).defaultLabel, "Allowed (no rule)");
  assert.equal(row([orgRule("block")], organization).notice, null);
});

test("team and person defaults ignore their own rules and use applicable inherited layers", () => {
  const rules = [orgRule("allow"), rule(team, "ask"), rule(person, "block")];
  assert.equal(row(rules, team).defaultLabel, "Default (Allow)");
  assert.equal(row(rules, person).defaultLabel, "Default (Ask)");
  assert.equal(row([orgRule("block"), ...rules.slice(1)], person).defaultLabel, "Default (Block)");
  assert.equal(row([orgRule("ask"), rule(team, "block", "*")], person).defaultLabel, "Default (Block)");
  assert.equal(row([], team).defaultLabel, "Allowed (no rule)");
});

test("without a catalog, Default still names a known inherited rule", () => {
  assert.equal(row([orgRule("ask")], team).defaultLabel, "Default (Ask)");
  assert.equal(row([rule(team, "block")], person).defaultLabel, "Default (Block)");
  assert.equal(row([rule(person, "allow")], person).defaultLabel, "Allowed (no rule)");
});

test("the pressed segment is the audience's own rule, or Default after removal", () => {
  assert.equal(row([orgRule("allow")], organization).pressed, "allow");
  assert.equal(row([orgRule("block")], team).pressed, "default");
  const rules = [orgRule("ask"), rule(person, "allow")];
  assert.equal(row(rules, person).pressed, "allow");
  const cleared = withPendingRule(rules, { subject: person, connectionId, toolName, rule: null });
  assert.equal(row(cleared, person).pressed, "default");
});

test("a saved choice reports whichever stricter rule wins, or that the choice applies", () => {
  assert.equal(row([orgRule("ask"), rule(person, "allow")], person).notice, "Applies now: Ask, from Everyone.");
  assert.equal(row([rule(team, "ask"), rule(person, "allow")], person).notice, "Applies now: Ask, from the team Support.");
  assert.equal(row([orgRule("ask"), rule(team, "block"), rule(person, "allow")], person).notice, "Applies now: Block, from the team Support.");
  assert.equal(row([orgRule("block"), rule(team, "block"), rule(person, "allow")], person).notice, "Applies now: Block, from Everyone.");
  assert.equal(row([orgRule("ask"), rule(person, "block")], person).notice, "This rule applies.");
  assert.equal(row([orgRule("ask"), rule(person, "ask")], person).notice, "This rule applies.");
  assert.equal(row([rule(person, "allow")], person).notice, "This rule applies.");
});

test("Default reports its source or indicates that no rule applies", () => {
  assert.equal(row([orgRule("ask")], team).notice, "From Everyone: Ask.");
  assert.equal(row([rule(team, "ask")], person).notice, "From the team Support: Ask.");
  assert.equal(row([], person).notice, "Allowed (no rule).");
});

test("an Everyone tool lock keeps the saved segment pressed and explains the effective block", () => {
  const locked = row([orgRule("block"), rule(team, "allow")], team);
  assert.equal(locked.pressed, "allow");
  assert.equal(locked.notice, "Applies now: Block, from Everyone.");
  assert.equal(locked.lockedByEveryone, true);
  assert.equal(row([orgRule("block")], team).notice, "From Everyone: Block.");
  assert.equal(row([orgRule("block")], organization).lockedByEveryone, false);
  assert.equal(row([orgRule("block", "*")], person).lockedByEveryone, false);
});

test("a whole-connection block applies without changing the pressed segment or inherited default", () => {
  const locked = row([orgRule("ask"), rule(team, "block", "*"), rule(team, "allow")], team);
  assert.equal(locked.pressed, "allow");
  assert.equal(locked.defaultLabel, "Default (Ask)");
  assert.equal(locked.notice, "Applies now: Block, from the connection rule.");
  assert.equal(row([rule(team, "block", "*")], team).notice, "From the connection rule: Block.");
  assert.equal(row([rule(team, "block", "*")], person).notice, "From the team Support: Block.");
});

test("a pending edit replaces or removes only the chosen rule, without changing confirmed rules", () => {
  const confirmed = [orgRule("allow"), rule(team, "ask")];
  const target = { subject: team, connectionId, toolName };
  assert.equal(accessForTool(toolName, rulesOf(withPendingRule(confirmed, { ...target, rule: "block" }))).access, "block");
  assert.equal(accessForTool(toolName, rulesOf(withPendingRule(confirmed, { ...target, rule: null }))).access, "allow");
  assert.equal(accessForTool(toolName, rulesOf(withPendingRule(confirmed))).access, "ask");
});
