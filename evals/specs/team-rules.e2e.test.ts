import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { teamRules, teamRulesChat, teamRulesEditor, type TeamRule } from "../worlds/team-rules.ts";

const test = spec.world(teamRules, { timeout: 600_000, resources: { surfaces: [], services: ["den"] } });
const editorTest = spec.world(teamRulesEditor, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });
const chatTest = spec.world(teamRulesChat, { timeout: 900_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] } });

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

editorTest("an owner writes the Contractors team's command rules in its permissions and checks a command before saving", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);
  const saved: TeamRule[] = [
    { action: "shell", resource: "*", effect: "deny" },
    { action: "shell", resource: "git status", effect: "allow" },
  ];

  await step("before: the Contractors permissions have no rules, so the team can run every command", async () => {
    await owner.see({ text: "Contractors Permissions" }, { timeoutMs: 90_000 });
    await owner.click({ role: "tab", label: "Rules" });
    await owner.see({ testId: "permission-rule-block-shell" });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules", `${received.length} before the owner saves`, received.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });

  await step("the owner blocks every command but git status, and trying git push shows the rule that blocks it", async () => {
    await owner.click({ testId: "permission-rule-block-shell" });
    await owner.type({ testId: "permission-rule-shell-0" }, "*");
    await owner.click({ testId: "permission-rule-allow-shell" });
    await owner.type({ testId: "permission-rule-shell-1" }, "git status");
    await owner.type({ testId: "permission-rule-try-shell" }, "git push origin main");
    await owner.see({ testId: "permission-rule-result-shell" }, { text: "Blocked by rule 1" });
    await owner.type({ testId: "permission-rule-try-shell" }, "git status", { replace: true });
    await owner.see({ testId: "permission-rule-result-shell" }, { text: "Allowed" });
    evidence.recordAssertionEvidence("trying commands", "git push origin main → Blocked by rule 1 (*); git status → Allowed", true);
    await owner.screenshot();
  });

  await step("after: the owner saves and the team's member receives exactly those rules", async () => {
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Saved 1 rule list" }, { timeoutMs: 30_000 });
    const received = await world.receivedRules("riley");
    const expected = saved.map((rule) => ({ ...rule, source: "Contractors Permissions" }));
    evidence.recordAssertionEvidence("Riley's rules", JSON.stringify(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("a member outside the team receives nothing, and the team's member cannot change the rules", async () => {
    const outside = await world.receivedRules("morgan");
    const status = await world.memberSaveStatus();
    evidence.recordAssertionEvidence("boundaries", `Morgan: ${outside.length} rules; Riley saving the Contractors rules → HTTP ${status}`, outside.length === 0 && status === 403);
    expect(outside).toEqual([]);
    expect(status).toBe(403);
  });
});

chatTest("a contractor's agent cannot run a command the Contractors rules block, while a colleague outside the team can", async ({ world, user, agent, probe, step, evidence }) => {
  const riley = { user: user.on(world.riley.app), agent: agent.on(world.riley.app) };
  const morgan = { user: user.on(world.morgan.app), agent: agent.on(world.morgan.app) };
  const settledShell = (member: typeof world.riley) => probe.eventually(() => member.shellCall(), {
    within: 120_000, label: "the shell call settled in the engine", until: (call) => call !== null,
  });

  await step("given the contractor's engine has the Contractors rules and the colleague's has none", async () => {
    const rileyPlugin = await world.riley.teamRulesPlugin({ until: (plugin) => plugin?.state === "active" });
    const morganPlugin = await world.morgan.teamRulesPlugin({ until: (plugin) => plugin === null });
    await riley.user.see("composer");
    evidence.recordAssertionEvidence("team rules in each engine", `Riley: ${JSON.stringify(rileyPlugin)}; Morgan: ${JSON.stringify(morganPlugin)}`, rileyPlugin?.state === "active" && morganPlugin === null);
    expect(rileyPlugin?.state).toBe("active");
    expect(morganPlugin).toBeNull();
  });

  await step("when the contractor asks the agent to save a note with printf", async () => {
    await riley.user.type("composer", world.riley.prompt);
    await riley.agent.run("composer.send");
    const call = await settledShell(world.riley);
    evidence.recordAssertionEvidence("the agent's shell call", `${call?.status ?? "none"}: ${world.riley.command}`, call?.status === "error");
    await riley.user.see({ text: "I tried to save the note." }, { timeoutMs: 60_000 });
    await riley.user.screenshot();
  });

  await step("then: the command never ran, and the agent was told which rule blocked it", async () => {
    const call = await world.riley.shellCall();
    const wrote = await world.riley.wroteNote();
    const told = call?.error.includes('"Contractors Permissions" (rule: *)') === true;
    evidence.recordAssertionEvidence("blocked before it ran", `note written: ${wrote}; tool error: ${call?.error ?? "(none)"}`, !wrote && told);
    expect(wrote).toBe(false);
    expect(told).toBe(true);
  });

  await step("a colleague outside the team gets the same command run", async () => {
    await morgan.user.type("composer", world.morgan.prompt);
    await morgan.agent.run("composer.send");
    const call = await settledShell(world.morgan);
    const wrote = await world.morgan.wroteNote();
    evidence.recordAssertionEvidence("Morgan's shell call", `${call?.status ?? "none"}; note written: ${wrote}`, call?.status === "completed" && wrote);
    expect(call?.status).toBe("completed");
    expect(wrote).toBe(true);
    await morgan.user.see({ text: "I tried to save the note." }, { timeoutMs: 60_000 });
    await morgan.user.screenshot();
  });
});
