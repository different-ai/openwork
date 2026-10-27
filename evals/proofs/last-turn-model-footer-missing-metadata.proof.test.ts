import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { lastTurnModelFooter } from "../worlds/last-turn-model-footer.ts";

const test = spec.world(lastTurnModelFooter, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

// The real native engine omits resolvedModel: use the requested model's public
// catalog name, without claiming to have observed an upstream routing decision.
test("a member sees the requested model's human name even when the engine omits resolved identity", async ({ world, user, probe, step, evidence }) => {
  const labels = async () => (await probe.dom('[data-testid="reply-model"]')).elements;
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("given: two completed replies have no resolved model identity", async () => {
    await user.reload();
    await user.see({ text: world.latest.reply });
    await user.see({ text: world.older.reply });
    await user.hover("composer");
    expect(world.repliesWithoutResolvedMetadata).toBe(2);
    const found = await probe.eventually(labels, { within: 15_000, label: "both requested model names", until: values => values.length === 2 });
    expect(found.every(value => value.text.includes(world.modelName))).toBe(true);
    evidence.recordAssertionEvidence("Both native replies retain the requested model without resolved metadata", `replies without resolved metadata=${world.repliesWithoutResolvedMetadata}; labels=${found.length}; name=${world.modelName}`, world.repliesWithoutResolvedMetadata === 2 && found.length === 2);
    await user.screenshot();
  });

  await step("after: the latest reply shows its human model name below the answer without an organization override", async () => {
    await user.see({ testId: "reply-model", nth: 0 });
    const found = await labels();
    expect(found.map(value => value.text)).toEqual([`Replied with ${world.modelName}`, `Replied with ${world.modelName}`]);
    expect((await probe.dom('[data-testid="completed-work-rail"] [data-testid="reply-model"]')).elements).toHaveLength(0);
    expect((await probe.dom('[data-testid="reply-model"] img[src*="ipr_"]')).elements).toHaveLength(0);
    expect(found.every(value => !/ipr_|gwm_/.test(value.text))).toBe(true);
    evidence.recordAssertionEvidence("Completed replies use the shared catalog title without opaque IDs or logo requests", `footer labels=${found.length}; name=${world.modelName}; opaque IDs=0; opaque provider logos=0`, found.length === 2 && found.every(value => !/ipr_|gwm_/.test(value.text)));
    await user.screenshot();
  });

  await step("a narrow touch screen keeps the requested model and actions visible without sideways scrolling", async () => {
    await world.touchInput();
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ text: world.latest.reply });
    await user.see({ role: "button", label: "Branch in new chat", nth: 0 });
    await user.see({ testId: "reply-model", nth: 0 });
    const layout = await probe.dom('[data-testid="reply-model"]');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.elements.every(value => value.text === `Replied with ${world.modelName}`)).toBe(true);
    evidence.recordAssertionEvidence("The requested model footer fits a touch screen", `viewport=${layout.viewportWidth}; document=${layout.documentWidth}; model=${world.modelName}`, layout.documentWidth <= layout.viewportWidth);
    await user.screenshot();
  });
});
