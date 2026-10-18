import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { appActivityEvidence, BUILD_PROMPT, GUIDE_PROMPT, SKILL_PROMPT } from "../worlds/app-activity-evidence.ts";

const test = spec.world(appActivityEvidence, { timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["mock"] } });

test("a person sees failed App steps and saved results without invented progress", async ({ world, user, probe, step, evidence }) => {
  await step("after: unavailable instructions stay visible after the answer", async () => {
    await world.armFlicker();
    await user.type("composer", GUIDE_PROMPT);
    await user.click("Run task");
    await user.see({ text: "The instructions are unavailable; request access before retrying." }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const layout = await world.flicker();
    const rows = await probe.dom("[data-app-builder-failure]");
    evidence.recordAssertionEvidence("The failed instruction read remains outside disclosure", `${rows.elements.length} visible failure rows; layout upward jumps=${layout.upwardJumps}; positions=${layout.samples.join(",")}`, rows.elements.length > 0 && layout.visibleSamples > 0 && layout.upwardJumps <= 1);
    expect(layout.visibleSamples).toBeGreaterThan(0);
    expect(layout.upwardJumps).toBeLessThanOrEqual(1);
    await user.see({ text: "Needs attention" });
    expect(rows.elements.length).toBeGreaterThan(0);
    await user.notSee({ text: "Read the build guide" });
    await user.screenshot();
  });
  await step("after: a saved App survives the script failing later", async () => {
    await world.armFlicker();
    await user.type("composer", BUILD_PROMPT);
    await user.click("Run task");
    await user.see({ text: "The project board was saved. The later script step failed." }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "App “Project board”" });
    await user.see({ text: /^Saved$/ });
    await user.see({ role: "button", label: "Open preview" });
    const open = await probe.dom('[data-built-app-result] button:not(:disabled)');
    const failures = await probe.dom("[data-code-mode-script-error]");
    const scriptFailure = failures.elements.some(row => row.text.includes("Later script failure") && row.rect.height > 0);
    const saved = await world.savedMessages();
    const created = (await world.toolCalls()).find(call => call.name === "create_app");
    const sourceBytes = typeof created?.args.reactSource === "string" ? new TextEncoder().encode(created.args.reactSource).byteLength : 0;
    const layout = await world.flicker();
    const retained = open.elements.length > 0 && scriptFailure && saved.includes("openworkMcpResults") && sourceBytes === 200_000 && layout.visibleSamples > 0 && layout.upwardJumps <= 1;
    evidence.recordAssertionEvidence("The saved App offers Open while the script's own failure stays visible", `enabled Open actions=${open.elements.length}; separate script error=${scriptFailure}; native receipt=${saved.includes("openworkMcpResults")}; authored input=${sourceBytes} bytes; upward jumps=${layout.upwardJumps}; positions=${layout.samples.join(",")}`, retained);
    expect(sourceBytes).toBe(200_000);
    expect(open.elements.length).toBeGreaterThan(0);
    expect(scriptFailure).toBe(true);
    expect(layout.visibleSamples).toBeGreaterThan(0);
    expect(layout.upwardJumps).toBeLessThanOrEqual(1);
    expect(retained).toBe(true);
    await user.notSee({ text: "Built and verified" });
    await user.notSee({ text: "Tools ready" });
    await user.screenshot();
  });
  await step("after: delivered instructions remain inspectable when the finished work folds", async () => {
    await user.type("composer", SKILL_PROMPT);
    await user.click("Run task");
    await user.see({ text: "All five report sections were checked." }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "Loaded “review” instructions" });
    const loaded = await probe.eventually(() => probe.dom('[data-skill-evidence="instructions-loaded"]'), {
      within: 15_000, intervalMs: 100, label: "the completed work folds without hiding the instruction receipt", until: snapshot => snapshot.elements.length > 0,
    });
    const actual = (await world.toolCalls()).filter(call => call.name === "skill");
    evidence.recordAssertionEvidence("The loaded instruction receipt is visible beside the folded work", `${loaded.elements.length} visible receipts; ${actual.length} real retrieval calls`, loaded.elements.length > 0 && actual.length > 0);
    expect(loaded.elements.length).toBeGreaterThan(0);
    expect(actual.length).toBeGreaterThan(0);
    await user.notSee({ text: /Used your .* skill/ });
    await user.screenshot();
  });
  await step("after: reloading keeps the same saved App and instruction evidence", async () => {
    await user.reload();
    await user.see({ text: "App “Project board”" }, { timeoutMs: 30_000 });
    await user.see({ text: "Loaded “review” instructions" });
    const checklists = await probe.dom("[data-app-builder-checklist]");
    evidence.recordAssertionEvidence("History contains observed outcomes rather than inferred stage checkmarks", `${checklists.elements.length} inferred checklists after reload`, checklists.elements.length === 0);
    expect(checklists.elements).toHaveLength(0);
    await user.screenshot();
  });
});
