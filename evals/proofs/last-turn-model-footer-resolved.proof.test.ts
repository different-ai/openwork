import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { lastTurnModelFooterResolved } from "../worlds/last-turn-model-footer-resolved.ts";

const test = spec.world(lastTurnModelFooterResolved, {
  timeout: 240_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { commands: ["bun"] },
});

// Seeded native HTTP history, projected by the real app into verified reply metadata.
// This proves presentation, not that an inference provider reports its routed identity.
test("a member sees the last reply's verified model below the answer without repeating it above the work", async ({ world, user, probe, step, evidence }) => {
  const normal = `[data-session-surface-id="${world.normal.sessionId}"]`;
  const auto = `[data-session-surface-id="${world.auto.sessionId}"]`;
  const labels = async () => (await probe.dom(`${normal} [data-testid="reply-model"]`)).elements;
  const topLabels = async () => (await probe.dom(`${normal} [data-testid="completed-work-rail"] [data-testid="reply-model"]`)).elements;

  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("given: the member opens two completed answers without a footer feature override", async () => {
    await user.click({ text: "Model footer" });
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.see({ text: world.older.reply });
    const found = await probe.eventually(labels, { within: 15_000, label: "both verified model labels", until: values => values.length === 2 });
    expect(world.fixtureReads).toBeGreaterThan(0);
    expect(found.every(value => value.text.includes(world.modelName))).toBe(true);
    evidence.recordAssertionEvidence("Both completed answers retain their verified model identity", `history reads=${world.fixtureReads}; labels=${found.length}; model=${world.modelName}`, world.fixtureReads > 0 && found.length === 2);
    await user.screenshot();
  });

  await step("after: the latest answer keeps its model visible below the reply while actions stay quiet", async () => {
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.hover("composer");
    await probe.eventually(() => probe.dom(`${normal} [data-testid="reply-model"] .sr-only`), {
      within: 15_000, label: "both accessible footer prefixes", until: value => value.elements.length === 2,
    });
    await user.see({ testId: "reply-model", nth: 0 });
    await user.notSee({ testId: "reply-model", nth: 1 });
    await user.notSee({ testId: "reply-actions" });
    const found = await labels();
    expect(found.map(value => value.text)).toEqual([`Replied with ${world.modelName}`, `Replied with ${world.modelName}`]);
    expect(await topLabels()).toHaveLength(0);
    const answers = (await probe.dom(`${normal} [data-message-role="assistant"]`)).elements;
    expect(found[1]?.rect.top).toBeGreaterThanOrEqual(answers.at(-1)?.rect.bottom ?? Number.POSITIVE_INFINITY);
    const icons = (await probe.dom(`${normal} [data-testid="reply-model"] [aria-hidden="true"]`)).elements;
    expect(icons.every(icon => icon.rect.width === 12 && icon.rect.height === 12)).toBe(true);
    const rails = (await probe.dom(`${normal} [data-testid="completed-work-rail"]`)).elements;
    expect(rails.some(rail => rail.text.includes("5 steps"))).toBe(true);
    expect(rails.every(rail => !rail.text.includes(world.modelName))).toBe(true);
    evidence.recordAssertionEvidence("The latest verified model has one footer home and a fixed logo slot", `footers=${found.length}; visible at rest=1; top model labels=0; icon slots=${icons.length} at 12px`, found.length === 2 && icons.length === 2 && rails.every(rail => !rail.text.includes(world.modelName)));
    await user.screenshot();
  });

  await step("hovering the latest answer reveals its actions without moving the model", async () => {
    const before = (await labels())[1]?.rect;
    await user.hover({ text: world.latest.reply });
    await user.see({ testId: "reply-actions", nth: 0 });
    await user.notSee({ testId: "reply-actions", nth: 1 });
    const after = (await labels())[1]?.rect;
    expect(after?.left).toBe(before?.left);
    expect(after?.top).toBe(before?.top);
    evidence.recordAssertionEvidence("Hover changes action visibility, not model position", `before=${before?.left},${before?.top}; after=${after?.left},${after?.top}`, before?.left === after?.left && before?.top === after?.top);
    await user.screenshot();
  });

  await step("hovering an older answer reveals its model without repeating it in collapsed work", async () => {
    await user.hover({ text: world.older.reply });
    await user.see({ testId: "reply-model", nth: 1 });
    await user.see({ testId: "reply-actions", nth: 0 });
    const found = await labels();
    expect(found).toHaveLength(2);
    expect(await topLabels()).toHaveLength(0);
    evidence.recordAssertionEvidence("The older reply reveals its existing model footer", `visible model labels=2; total labels=${found.length}; model names in collapsed work=0`, found.length === 2);
    await user.screenshot();
  });

  await step("a gateway reply without resolved identity uses the same human model name as the picker", async () => {
    await user.click({ text: "Gateway reply" });
    await user.see({ text: world.gatewayReply.reply });
    await user.click("Change model");
    await user.see({ testId: "composer-model-picker" });
    const picker = await probe.eventually(() => probe.dom(`[data-testid="composer-model-picker"] [data-model-key="${world.gatewayIdentity.providerID}:${world.gatewayIdentity.id}"]`), {
      within: 15_000, label: "the assigned gateway model in the shared picker", until: value => value.elements.length === 1,
    });
    expect(picker.elements[0]?.text).toBe(world.gatewayName);
    await user.press("Escape");
    await user.hover("composer");
    await user.see({ testId: "reply-model" });
    const surface = `[data-session-surface-id="${world.gateway.sessionId}"]`;
    const found = (await probe.dom(`${surface} [data-testid="reply-model"]`)).elements;
    expect(found.map(value => value.text)).toEqual([`Replied with ${world.gatewayName}`]);
    expect(found.every(value => !/ipr_|gwm_/.test(value.text))).toBe(true);
    expect((await probe.dom(`${surface} [data-testid="reply-model"] img[src*="ipr_"]`)).elements).toHaveLength(0);
    expect((await probe.dom(`${surface} [data-testid="completed-work-rail"] [data-testid="reply-model"]`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("An unresolved gateway reply uses its assigned catalog title, never routing IDs", `footer labels=${found.length}; name=${world.gatewayName}; opaque IDs=0; opaque logo requests=0`, found.length === 1 && found[0]?.text === `Replied with ${world.gatewayName}`);
    await user.screenshot();
  });

  await step("an Auto reply names its routed model once beside the OpenWork mark", async () => {
    await user.click({ text: "Auto reply" });
    await user.see({ text: world.autoReply.reply });
    await user.hover("composer");
    await user.see({ testId: "reply-model" });
    const found = (await probe.dom(`${auto} [data-testid="reply-model"]`)).elements;
    const marks = (await probe.dom(`${auto} [data-testid="reply-model"] svg[aria-label="OpenWork"]`)).elements;
    expect(found.map(value => value.text)).toEqual([`Replied with ${world.autoModelName}`]);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.rect.width).toBe(12);
    expect((await probe.dom(`${auto} [data-testid="completed-work-rail"] [data-testid="reply-model"]`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Auto retains the OpenWork mark and discloses only the routed reply name", `routed name=${world.autoModelName}; footer labels=${found.length}; OpenWork marks=${marks.length}`, found.length === 1 && marks.length === 1);
    await user.screenshot();
  });

  await step("a narrow touch screen keeps the model and actions visible without hover", async () => {
    await world.touchInput();
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ text: world.autoReply.reply });
    await user.see({ testId: "reply-model" });
    await user.see({ testId: "reply-actions" });
    const layout = await probe.dom(`${auto} [data-testid="reply-model"]`);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.elements[0]?.rect.right).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("The model footer fits the narrow touch layout", `viewport=${layout.viewportWidth}; document=${layout.documentWidth}; model labels=${layout.elements.length}`, layout.documentWidth <= layout.viewportWidth && layout.elements.length === 1);
    await user.screenshot();
  });

  await step("reopening the conversation preserves the Auto model footer and answer", async () => {
    const readsBeforeReload = world.autoHistoryReads;
    await user.reload();
    // Page.reload can return while the outgoing document is still complete.
    // Witness the new history request before checking the rehydrated transcript,
    // rather than accepting visibility checks against the outgoing page.
    const readsAfterReload = await probe.eventually(() => world.autoHistoryReads, {
      within: 15_000, label: "Auto history reloaded from the native engine", until: reads => reads > readsBeforeReload,
    });
    const reloaded = await probe.eventually(() => probe.dom(`${auto} [data-testid="reply-model"]`), {
      within: 15_000, label: "the reopened Auto conversation's model footer", until: value => value.elements.length === 1,
    });
    await user.see({ text: world.autoReply.reply });
    await user.see({ testId: "reply-model" });
    const found = reloaded.elements;
    expect(readsAfterReload).toBeGreaterThan(readsBeforeReload);
    expect(found.map(value => value.text)).toEqual([`Replied with ${world.autoModelName}`]);
    expect((await probe.dom(`${auto} [data-testid="completed-work-rail"] [data-testid="reply-model"]`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Reload retains one footer rather than restoring a duplicate above the answer", `Auto history reads=${readsBeforeReload}→${readsAfterReload}; footer labels=${found.length}; reply preserved; model=${world.autoModelName}`, readsAfterReload > readsBeforeReload && found.length === 1);
    await user.screenshot();
  });
});
