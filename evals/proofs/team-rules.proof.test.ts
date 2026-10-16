import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { teamRules, type TeamRule } from "../worlds/team-rules.ts";

const test = spec.world(teamRules, { timeout: 600_000, resources: { surfaces: [], services: ["den"] } });

const contractorRules: TeamRule[] = [
  { action: "shell", resource: "*", effect: "deny" },
  { action: "shell", resource: "git status", effect: "allow" },
  { action: "shell", resource: "git log *", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "https://docs.example.com/*", effect: "allow" },
  { action: "skill", resource: "*", effect: "deny" },
  { action: "mcp", resource: "*", effect: "deny" },
  { action: "mcp", resource: "issue-tracker", effect: "allow" },
];

test("an admin's rules in a team's permissions reach that team's members and nobody else", async ({ world, step, evidence }) => {
  await step("before: with permission rules off, a contractor's app receives no rules", async () => {
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's desktop config", `${received.length} rules while permission rules are off`, received.length === 0);
    expect(received).toEqual([]);
  });

  await step("when the organization turns permission rules on and the admin saves the Contractors rules", async () => {
    const orgId = await world.enableTeamRules();
    await world.saveTeamRules(contractorRules);
    evidence.recordAssertionEvidence("permissionRules", `enabled for organization ${orgId}; ${contractorRules.length} rules saved in Contractors Permissions`, Boolean(orgId));
    expect(orgId).not.toBe("");
  });

  await step("after: the contractor's app receives the Contractors rules in order, named after the team's permissions", async () => {
    const received = await world.receivedRules("riley");
    const expected = contractorRules.map((rule) => ({ ...rule, source: "Contractors Permissions" }));
    evidence.recordAssertionEvidence("Riley's rules", `${received.length} rules: ${received.map((rule) => `${String(rule.action)} ${String(rule.resource)} → ${String(rule.effect)}`).join("; ")}`, JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
  });

  await step("a member outside the team receives no rules, and the team's member cannot change them", async () => {
    const received = await world.receivedRules("morgan");
    const status = await world.memberSaveStatus();
    evidence.recordAssertionEvidence("boundaries", `Morgan: ${received.length} rules; Riley saving the Contractors rules → HTTP ${status}`, received.length === 0 && status === 403);
    expect(received).toEqual([]);
    expect(status).toBe(403);
  });

  await step("Member permissions' rules reach everyone, ahead of a team's rules so the team's win", async () => {
    await world.saveMemberRules([{ action: "shell", resource: "curl *", effect: "deny" }]);
    const riley = await world.receivedRules("riley");
    const morgan = await world.receivedRules("morgan");
    const ok = riley.length === contractorRules.length + 1 && riley[0]?.source === "Member permissions" && riley[1]?.source === "Contractors Permissions"
      && morgan.length === 1 && morgan[0]?.resource === "curl *";
    evidence.recordAssertionEvidence("rule order", `Riley: ${riley.slice(0, 3).map((rule) => `${String(rule.source)}: ${String(rule.resource)}`).join(", ")}…; Morgan: ${morgan.map((rule) => `${String(rule.source)}: ${String(rule.resource)}`).join(", ")}`, ok);
    expect(ok).toBe(true);
  });
});
