import assert from "node:assert/strict";
import test from "node:test";
import { createComputerAgentPermissions } from "./computer-agent-permissions.mjs";

const rule = (action = "computer", effect = "ask", source = "Everyone") => ({ action, resource: "*", effect, source });
function fixture({ confirm = async () => true } = {}) {
  let clock = 0;
  let reads = 0;
  let rules = [];
  let failed = false;
  const policy = createComputerAgentPermissions({
    readRules: async () => { reads++; if (failed) throw new Error("offline"); return rules; },
    confirm, now: () => clock,
  });
  return { policy, setRules: value => { rules = value; }, fail: () => { failed = true; }, tick: () => { clock += 30_000; }, reads: () => reads };
}

for (const kind of ["computer", "script"]) test(`${kind} allows by default and applies allow, ask and deny`, async () => {
  const f = fixture();
  assert.deepEqual(await f.policy.check({ kind }), { effect: "allow" });
  for (const effect of ["allow", "ask", "deny"]) {
    f.setRules([rule(kind, effect)]); f.tick();
    const decision = await f.policy.check({ kind });
    assert.equal(decision.effect, effect);
    if (effect === "ask") assert.deepEqual(decision.rule, rule(kind, effect));
    if (effect === "deny") assert.match(decision.message, /Your organization's agent permissions block .+ \(set for Everyone\)\./);
  }
});

test("rules are cached for 30 seconds, then refreshed; read errors retain the last known rules", async () => {
  const f = fixture(); f.setRules([rule("computer", "deny")]);
  assert.equal((await f.policy.check({ kind: "computer" })).effect, "deny");
  f.setRules([]);
  assert.equal((await f.policy.check({ kind: "computer" })).effect, "deny");
  assert.equal(f.reads(), 1);
  f.fail(); f.tick();
  assert.equal((await f.policy.check({ kind: "computer" })).effect, "deny");
  assert.equal(f.reads(), 2);
});

test("a successful refresh expires cached rules and an empty policy restores current behavior", async () => {
  const f = fixture(); f.setRules([rule("computer", "deny")]);
  await f.policy.check({ kind: "computer" });
  f.setRules([]); f.tick();
  assert.deepEqual(await f.policy.check({ kind: "computer" }), { effect: "allow" });
  assert.equal(f.reads(), 2);
});

test("without a known policy a read error leaves current behavior unchanged", async () => {
  const f = fixture(); f.fail();
  assert.deepEqual(await f.policy.check({ kind: "computer" }), { effect: "allow" });
});

test("approval belongs to one chat and resets only when the ordered rules change", async () => {
  let asks = 0;
  const f = fixture({ confirm: async () => { asks++; return true; } });
  f.setRules([rule()]); await f.policy.check({ kind: "computer" });
  assert.equal(await f.policy.approveComputer("chat", rule()), true);
  assert.equal(await f.policy.approveComputer("chat", rule()), true);
  assert.equal(asks, 1);
  await f.policy.approveComputer("other", rule()); assert.equal(asks, 2);
  f.setRules([{ source: "Everyone", effect: "ask", resource: "*", action: "computer" }]); f.tick();
  await f.policy.check({ kind: "computer" });
  await f.policy.approveComputer("chat", rule()); assert.equal(asks, 2, "object property order does not change policy");
  f.setRules([rule("computer", "ask", "Contractors")]); f.tick();
  const decision = await f.policy.check({ kind: "computer" });
  await f.policy.approveComputer("chat", decision.rule); assert.equal(asks, 3);
});

for (const answer of [false, undefined, null, 0, 1, "allow"]) test(`only explicit true approves, not ${String(answer)}`, async () => {
  const f = fixture({ confirm: async () => answer });
  assert.equal(await f.policy.approveComputer("chat", rule()), false);
});

test("a rejected dialog is not approval", async () => {
  const f = fixture({ confirm: async () => { throw new Error("closed"); } });
  assert.equal(await f.policy.approveComputer("chat", rule()), false);
});

test("concurrent asks in a chat share one promise; changed rules invalidate a pending answer", async () => {
  let asks = 0;
  let resolve;
  const answer = new Promise(done => { resolve = done; });
  const f = fixture({ confirm: () => { asks++; return answer; } });
  f.setRules([rule()]); await f.policy.check({ kind: "computer" });
  const first = f.policy.approveComputer("chat", rule());
  assert.equal(f.policy.approveComputer("chat", rule()), first);
  await Promise.resolve(); assert.equal(asks, 1);
  f.setRules([rule("computer", "deny")]); f.tick();
  await f.policy.check({ kind: "computer" });
  f.setRules([rule()]); f.tick();
  await f.policy.check({ kind: "computer" });
  resolve(true);
  assert.equal(await first, false, "restoring the earlier rules cannot revive an old dialog");
});
