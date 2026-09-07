import { expect } from "vitest";
import { SkipError, spec } from "@openwork/testkit";
import { COMPUTER_TOOLS, CONTROL_PROMPT, OFF_PROMPT, START_PROMPT, coworkerComputerControlWorld } from "../worlds/coworker-computer-control.ts";

// Distinct from computer-use-window-scope: the real Coworker discussion grant,
// native engine plugin and exact running-tool broker context own every tool call.
const test = spec.world(coworkerComputerControlWorld, {
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_COMPUTER_CONTROL"] },
  timeout: 360_000,
});

test("A saved Coworker discussion controls only an approved disposable window and yields to its person", { timeout: 300_000 }, async ({ world, user, step }) => {
  const waitGate = async (gate: string) => {
    await expect.poll(() => {
      expect(world.model.errors).toEqual([]);
      return world.model.waiting.has(gate);
    }, { timeout: 45_000 }).toBe(true);
  };
  const waitReceipt = async (id: string) => {
    await expect.poll(() => {
      expect(world.model.errors).toEqual([]);
      return world.model.receipts.some((item) => item.id === id);
    }, { timeout: 45_000 }).toBe(true);
    return world.receipt(id);
  };
  let firstDiscussion: unknown;

  await step("A real saved discussion starts off, and unavailable remote control cannot select This Mac as a fallback", async () => {
    for (const prompt of [START_PROMPT, CONTROL_PROMPT, OFF_PROMPT]) {
      expect(prompt).not.toContain(world.fixture.appId);
      expect(prompt).not.toContain(String(world.fixture.appPid));
      expect(prompt).not.toContain("coworker_computer_");
    }
    await user.type({ label: "Message Editor" }, START_PROMPT);
    await user.click({ role: "button", text: "Send" });
    await user.see({ testId: "coworker-reply-bubble" }, { text: "The discussion is ready.", timeoutMs: 60_000 });
    await expect.poll(() => world.ui(), { timeout: 20_000 }).toMatchObject({ idle: true });
    await user.click({ testId: "coworker-discussion-switcher" });
    firstDiscussion = (await world.ui()).activeDiscussion;
    expect(firstDiscussion).toEqual(expect.stringMatching(/^ses_/));
    await user.press("Escape");
    await user.click({ testId: "coworker-computer-control" });
    await user.see({ testId: "coworker-computer-popover" });
    await user.see({ testId: "coworker-computer-status" }, { text: "Off for this discussion", timeoutMs: 20_000 });
    if ((await world.ui()).setupRequired) throw new SkipError("Accessibility and Screen Recording granted by a person to Coworker's actual bundled helper; no fixture input was attempted");
    expect(await world.ui()).toMatchObject({ target: "this-mac", placement: "Desktop", canAllow: true, canStop: false,
      targets: [{ id: "this-mac", disabled: false }, { id: "remote", disabled: true }] });
    await user.see({ testId: "coworker-computer-target-unavailable" }, { text: "Remote computer: A compatible remote service is not connected." });
    expect(world.model.calls).toEqual([]);
    expect(await world.helpers()).toEqual([]);
    expect(await world.fixture.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
  });

  await step("Allow in Coworker's real UI enables only this discussion, without starting native control", async () => {
    await user.click({ testId: "coworker-computer-allow" });
    await user.see({ testId: "coworker-computer-status" }, { text: "Allowed for this discussion", timeoutMs: 20_000 });
    expect(await world.helpers()).toEqual([]);
    expect(await world.fixture.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
    await user.press("Escape");
    await user.type({ label: "Message Editor" }, CONTROL_PROMPT);
    await user.click({ role: "button", text: "Send" });
    await waitGate("begin");
    await user.click({ testId: "coworker-computer-control" });
    world.model.release("begin");
    await waitReceipt("discover");
    const discovery = world.result("discover");
    expect(discovery).toMatchObject({ ok: true, protocol: "openwork.computer-use/1", permissions: { accessibility: true, screenRecording: true } });
    expect(discovery.apps).toEqual(expect.arrayContaining([expect.objectContaining({ app_id: world.fixture.appId })]));
    expect(JSON.stringify(discovery)).not.toContain("Initial draft");
    expect(JSON.stringify(discovery)).not.toContain("private-fixture-value");
    expect(await world.fixture.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
  });

  await step("Native approval selects the nondefault window; real engine refs edit it without reading protected or sibling content", async () => {
    expect(await world.fixture.selectWindow()).toMatchObject({ previous: "Other window", selected: "Workspace window" });
    expect(await world.helpers()).toHaveLength(1);
    await world.fixture.pressControl("Allow this session");
    await waitGate("control");
    expect(world.result("assist-open")).toMatchObject({ ok: true, mode: "assist", window_title: "Workspace window" });
    const observation = world.result("assist-observe");
    expect(observation).toMatchObject({ ok: true, protected_fields: 1 });
    expect(JSON.stringify(observation)).not.toContain("Other increment");
    expect(JSON.stringify(observation)).not.toContain("private-fixture-value");
    for (const id of ["assist-increment", "assist-edit"]) expect(world.result(id)).toMatchObject({ ok: true, status: "dispatched", outcome_verified: false });
    expect(world.result("assist-status")).toMatchObject({ ok: true, state: "active" });
    expect(world.result("assist-close")).toMatchObject({ ok: true });
    expect(await world.fixture.state()).toEqual({ count: 1, otherCount: 0, draft: "Reviewed in Coworker" });
    await expect.poll(() => world.helpers(), { timeout: 10_000 }).toEqual([]);
  });

  await step("Control-mode open stays in its original tool until the person clicks native Continue", async () => {
    world.model.release("control");
    expect(await world.fixture.selectWindow()).toMatchObject({ selected: "Workspace window" });
    await world.fixture.pressControl("Allow this session");
    await expect.poll(() => world.fixture.panel(), { timeout: 10_000 }).toMatchObject({ continue_enabled: true });
    await user.see({ testId: "coworker-computer-phase" }, { text: "Ready to continue", timeoutMs: 15_000 });
    expect(world.model.receipts.some((item) => item.id === "control-open")).toBe(false);
    expect((await world.ui()).idle).toBe(false);
    expect(await world.fixture.state()).toEqual({ count: 1, otherCount: 0, draft: "Reviewed in Coworker" });
    await world.fixture.pressControl("Continue");
    await waitGate("takeover");
    expect(world.result("control-open")).toMatchObject({ ok: true, state: "active", mode: "control", window_title: "Workspace window", next: "observe", fresh_observation_required: true });
    expect(await world.fixture.foregroundWindow()).toEqual({ title: "Workspace window" });
    expect(JSON.stringify(world.result("control-before"))).toContain("Reviewed in Coworker");
  });

  await step("Take over and real person typing suspend the same engine turn; Continue never replays the stale action", async () => {
    await world.fixture.pressControl("Take over");
    expect(await world.fixture.humanEdit()).toEqual({ ok: true });
    await expect.poll(() => world.fixture.state(), { timeout: 5_000 }).toEqual({ count: 1, otherCount: 0, draft: "Edited by person" });
    world.model.release("takeover");
    await expect.poll(() => world.model.calls.some((item) => item.id === "takeover-status"), { timeout: 10_000 }).toBe(true);
    await user.see({ testId: "coworker-computer-phase" }, { text: "Ready to continue", timeoutMs: 15_000 });
    await expect.poll(() => world.fixture.panel(), { timeout: 10_000 }).toMatchObject({ continue_enabled: true });
    expect(world.model.receipts.some((item) => item.id === "takeover-status")).toBe(false);
    expect((await world.ui()).idle).toBe(false);
    await world.fixture.pressControl("Continue");
    await waitGate("fresh");
    expect(world.result("takeover-status")).toMatchObject({ ok: true, state: "active", next: "observe", fresh_observation_required: true });
    expect(world.result("stale-action")).toMatchObject({ ok: false, code: "observation_required" });
    expect(await world.fixture.state()).toEqual({ count: 1, otherCount: 0, draft: "Edited by person" });
    world.model.release("fresh");
    await waitGate("stop");
    expect(JSON.stringify(world.result("control-fresh"))).toContain("Edited by person");
    expect(world.result("control-increment")).toMatchObject({ ok: true, status: "dispatched", outcome_verified: false });
    expect(await world.fixture.state()).toEqual({ count: 2, otherCount: 0, draft: "Edited by person" });
    for (const id of ["control-before", "control-fresh", "control-after"]) {
      const observed = world.result(id);
      expect(observed).toMatchObject({ ok: true, protected_fields: 1 });
      expect(JSON.stringify(observed)).not.toContain("Other increment");
      expect(JSON.stringify(observed)).not.toContain("private-fixture-value");
    }
  });

  await step("Stop & revoke releases the real helper, denies later tools, and a new saved discussion remains off", async () => {
    await user.click({ testId: "coworker-computer-stop" });
    await user.see({ testId: "coworker-computer-status" }, { text: "Off for this discussion", timeoutMs: 20_000 });
    await expect.poll(() => world.helpers(), { timeout: 10_000 }).toEqual([]);
    expect(await world.ui()).toMatchObject({ canStop: false, session: "" });
    world.model.release("stop");
    expect((await waitReceipt("after-stop")).output).toMatch(/disabled|revoked/i);
    await expect.poll(() => world.ui(), { timeout: 30_000 }).toMatchObject({ idle: true });
    await user.press("Escape");
    await user.click({ testId: "coworker-discussion-switcher" });
    await user.click({ testId: "coworker-new-discussion" });
    await user.type({ label: "Message Editor" }, OFF_PROMPT);
    await user.click({ role: "button", text: "Send" });
    expect((await waitReceipt("new-off")).output).toMatch(/disabled|revoked/i);
    await expect.poll(() => world.ui(), { timeout: 30_000 }).toMatchObject({ idle: true });
    await user.click({ testId: "coworker-discussion-switcher" });
    const secondDiscussion = (await world.ui()).activeDiscussion;
    expect(secondDiscussion).toEqual(expect.stringMatching(/^ses_/));
    expect(secondDiscussion).not.toBe(firstDiscussion);
    await user.press("Escape");
    await user.click({ testId: "coworker-computer-control" });
    await user.see({ testId: "coworker-computer-status" }, { text: "Off for this discussion", timeoutMs: 15_000 });
    expect(await world.ui()).toMatchObject({ target: "this-mac", placement: "Desktop", canStop: false,
      targets: [{ id: "this-mac", disabled: false }, { id: "remote", disabled: true }] });
    expect(await world.helpers()).toEqual([]);
    expect(await world.fixture.state()).toEqual({ count: 2, otherCount: 0, draft: "Edited by person" });
    expect([...new Set(world.model.calls.map((call) => call.name))].sort()).toEqual([...COMPUTER_TOOLS].sort());
    expect(world.model.errors).toEqual([]);
  });
});
