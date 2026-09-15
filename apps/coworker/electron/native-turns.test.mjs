import assert from "node:assert/strict";
import test from "node:test";
import { nativeTurnAgent, NATIVE_TURN_ROLES, NATIVE_COORDINATOR_AGENT } from "./native-turns.mjs";
import { COMPUTER_DENY } from "./computer-control.mjs";
import { EVENT_WRITE_DENY, EVENT_SCHEDULE_DENY } from "./event-execution.mjs";
import { workerTurnTools } from "./workers.mjs";

test("native turn roles accept only exact finite masks and never override an admitted agent pin", () => {
  assert.equal(nativeTurnAgent(), "build");
  assert.equal(nativeTurnAgent({ tools: null, agent: "progress-summary" }), "progress-summary");
  assert.equal(nativeTurnAgent({ tools: COMPUTER_DENY, agent: NATIVE_COORDINATOR_AGENT }), NATIVE_COORDINATOR_AGENT);
  for (const role of NATIVE_TURN_ROLES) {
    const tools = Object.fromEntries(Object.entries(role.tools).reverse());
    assert.equal(nativeTurnAgent({ tools }), role.id);
    assert.equal(nativeTurnAgent({ tools, agent: role.id }), role.id);
    assert.equal(nativeTurnAgent({ agent: role.id }), role.id);
    assert.ok(role.permissions.every((rule) => rule.effect === "deny"));
    assert.throws(() => nativeTurnAgent({ tools, agent: "custom-agent" }), /conflicting agent pin/);
    assert.throws(() => nativeTurnAgent({ tools: { ...tools, unknown: false } }), /Unsupported/);
  }
  for (const tools of [{ question: false }, { "*": false }, { coworker_react: false }, { ...COMPUTER_DENY, coworker_react: true }, { coworker_computer_act: true }, { ...COMPUTER_DENY, coworker_browser_tabs: true }, [], true, Object.create({ task: false })]) {
    assert.throws(() => nativeTurnAgent({ tools }), /Unsupported/);
  }
  assert.throws(() => nativeTurnAgent({ tools: COMPUTER_DENY, agent: "coworker-worker-computer" }), /conflicting agent pin/);
  for (const [suffix, policy] of [["", {}], ["-event-read-only", EVENT_WRITE_DENY], ["-schedule-read-only", EVENT_SCHEDULE_DENY]]) {
    const workerSuffix = suffix === "-schedule-read-only" ? "-event-read-only" : suffix;
    for (const [id, base] of [
      ["coworker", {}], ["coworker-no-computer", COMPUTER_DENY],
      ["coworker-no-referral", { coworker_team_refer: false }],
      ["coworker-group", { ...COMPUTER_DENY, coworker_team_refer: false }],
      ["coworker-worker", workerTurnTools()], ["coworker-worker-browser", workerTurnTools("browser")],
      ["coworker-worker-computer", workerTurnTools("computer")],
    ]) {
      if (id !== "coworker" || suffix) assert.equal(nativeTurnAgent({ tools: { ...base, ...policy } }), id + (id.startsWith("coworker-worker") ? workerSuffix : suffix));
      if (["coworker-no-referral", "coworker-group"].includes(id)) for (const conclude of [false, true]) {
        const tools = { ...base, ...policy, coworker_event_conclude: conclude };
        const role = id + suffix + (conclude ? "-conclusion" : "-no-conclusion");
        assert.equal(nativeTurnAgent({ tools }), role);
        assert.equal(nativeTurnAgent({ tools, agent: role }), role);
      }
    }
    const tools = { ...COMPUTER_DENY, ...policy, coworker_react: false };
    const id = "coworker-no-computer-no-reactions" + suffix;
    const role = NATIVE_TURN_ROLES.find((role) => role.id === id);
    assert.ok(role);
    assert.deepEqual(role.tools, tools);
    assert.equal(nativeTurnAgent({ tools }), id);
    assert.equal(nativeTurnAgent({ tools, agent: id }), id);
    assert.equal(nativeTurnAgent({ agent: id }), id);
    for (const action of Object.keys(tools)) assert.ok(role.permissions.some((rule) => rule.action === action && rule.effect === "deny"));
    for (const masked of [tools, { ...COMPUTER_DENY, ...policy }]) {
      assert.equal(nativeTurnAgent({ tools: masked, agent: NATIVE_COORDINATOR_AGENT }), NATIVE_COORDINATOR_AGENT);
    }
    assert.throws(() => nativeTurnAgent({ tools, agent: "coworker-no-computer" + suffix }), /conflicting agent pin/);
    assert.throws(() => nativeTurnAgent({ tools: { ...tools, unknown: false }, agent: NATIVE_COORDINATOR_AGENT }), /Unsupported/);
    assert.throws(() => nativeTurnAgent({ tools: { ...tools, coworker_react: true }, agent: NATIVE_COORDINATOR_AGENT }), /Unsupported/);
    for (const control of [undefined, "browser", "computer"]) {
      const workerTools = { ...workerTurnTools(control), ...policy };
      const workerId = "coworker-worker" + (control ? "-" + control : "") + workerSuffix;
      assert.equal(workerTools.coworker_react, false);
      assert.equal(nativeTurnAgent({ tools: workerTools }), workerId);
      assert.ok(NATIVE_TURN_ROLES.find((role) => role.id === workerId).permissions.some((rule) => rule.action === "coworker_react" && rule.effect === "deny"));
      assert.throws(() => nativeTurnAgent({ tools: workerTools, agent: NATIVE_COORDINATOR_AGENT }), /Unsupported/);
    }
  }
  for (const policy of [EVENT_WRITE_DENY, EVENT_SCHEDULE_DENY]) {
    assert.equal(nativeTurnAgent({ tools: { ...COMPUTER_DENY, ...policy }, agent: NATIVE_COORDINATOR_AGENT }), NATIVE_COORDINATOR_AGENT);
    for (const control of [undefined, "browser", "computer"]) {
      const tools = { ...workerTurnTools(control), ...policy };
      const role = NATIVE_TURN_ROLES.find((role) => role.id === nativeTurnAgent({ tools }));
      for (const action of Object.keys(policy)) assert.ok(role.permissions.some((rule) => rule.action === action && rule.effect === "deny"));
      assert.ok(role.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny"));
    }
    for (const conclude of [false, true]) {
      const tools = { ...COMPUTER_DENY, coworker_team_refer: false, coworker_event_conclude: conclude, ...policy };
      const role = NATIVE_TURN_ROLES.find((role) => role.id === nativeTurnAgent({ tools }));
      assert.equal(role.permissions.some((rule) => rule.action === "coworker_event_conclude"), !conclude);
      assert.ok(role.permissions.every((rule) => rule.effect === "deny"));
      assert.throws(() => nativeTurnAgent({ tools, agent: "coworker-group" }), /conflicting agent pin/);
    }
  }
});
