import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { commandPaletteModels } from "../worlds/chat.ts";

const test = spec.world(commandPaletteModels, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const paletteInput = { placeholder: "Search actions and settings…" };
const changeModel = { role: "button", label: "Change model" } as const;
const item = (id: string) => `[data-command-palette-item="${id}"]`;
const modelItem = (model: { providerID: string; modelID: string }) => item(`model:${model.providerID}:${model.modelID}`);

test("a member finds the model actions in the command palette with their keys and switches models from it", async ({ world, user, probe, step, evidence }) => {
  const texts = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());
  const composerModel = async () => (await texts('button[aria-label="Change model"]'))[0] ?? "";
  const paletteClosed = () => probe.eventually(() => probe.has("Arrow keys to navigate"), {
    within: 15_000, label: "command palette finishes closing", until: (open) => !open,
  });
  const openPalette = async (query: string) => {
    await user.click("composer");
    await user.press(world.paletteKey);
    await user.type(paletteInput, query, { replace: true });
  };
  await user.see(changeModel, { timeoutMs: 60_000 });
  const current = await composerModel();

  await step("before: typing “model” in the palette shows Models with the current model, then Next pinned model and Cycle model source with their keys", async () => {
    await openPalette("model");
    await user.see({ role: "option", label: /^Models/ });
    await user.see({ role: "option", label: /^Next pinned model/ });
    await user.see({ role: "option", label: /^Cycle model source/ });
    await user.screenshot();
    const models = await texts(`${item("models")} [data-slot="command-shortcut"]`);
    const next = await texts(`${item("models.next-pinned")} [data-slot="command-shortcut"]`);
    const source = await texts(`${item("models.next-source")} [data-slot="command-shortcut"]`);
    const nextRow = (await texts(item("models.next-pinned")))[0] ?? "";
    evidence.recordAssertionEvidence("Models row names the current model", `composer: ${current}; palette: ${models.join(", ")}`, models[0] === current);
    const keysRead = (next[0] === "⌃⇧M" && source[0] === "⌃⌥M") || (next[0] === "Ctrl+Shift+M" && source[0] === "Ctrl+Alt+M");
    evidence.recordAssertionEvidence("Key hints in this platform's notation", `Next pinned model ${next.join("")}, Cycle model source ${source.join("")}`, keysRead);
    expect(models).toEqual([current]);
    expect(keysRead, `Next pinned model ${next.join("")}, Cycle model source ${source.join("")}`).toBe(true);
    expect(nextRow).toContain(`${current} → `);
  });

  await step("Models lists every model by name with its provider, its mark set apart from its name, and the current one marked", async () => {
    await user.click({ role: "option", label: /^Models/ });
    await user.see({ placeholder: "Search models…" });
    await user.see({ role: "button", label: "Back" });
    await user.screenshot();
    for (const model of [world.auto, world.organization, world.favorite, world.byok]) {
      expect((await probe.dom(modelItem(model))).elements).toHaveLength(1);
    }
    const marks = (await probe.dom('[data-command-palette-item^="model:"] [data-slot="model-provider-mark"]')).elements;
    const names = (await probe.dom('[data-command-palette-item^="model:"] [data-slot="model-provider-mark"] + div')).elements;
    const gaps = marks.map((mark, index) => Math.round((names[index]?.rect.left ?? 0) - mark.rect.right));
    evidence.recordAssertionEvidence("Provider mark to name spacing", `${gaps.length} rows, gaps ${[...new Set(gaps)].join(", ")}px`, gaps.length > 3 && gaps.every((gap) => gap >= 8));
    expect(gaps.length).toBeGreaterThan(3);
    for (const gap of gaps) expect.soft(gap).toBeGreaterThanOrEqual(8);
    // Each row's second line names the provider, as the composer picker does, never the model id.
    const details = await texts('[data-command-palette-item^="model:"] [data-slot="command-item-detail"]');
    const leaked = details.filter((detail) => [world.organization, world.favorite, world.recent, world.byok].some((model) => detail.includes(model.modelID)) || /\w\/[\w.-]+/.test(detail));
    evidence.recordAssertionEvidence("Model rows name the provider, not the model id", details.slice(0, 5).join(" | "), details.length > 3 && leaked.length === 0);
    expect(details).toContain("Organization provider · pinned by your org");
    expect(details).toContain("BYOK provider");
    expect(leaked).toEqual([]);
    const marked = await texts('[data-command-palette-item^="model:"]:has([data-slot="command-shortcut"])');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(current);
    expect(marked[0]).toContain("Current");
  });

  await step("after: choosing BYOK witness in the palette switches the composer and closes the palette", async () => {
    await user.click({ role: "option", label: /^BYOK witness/ });
    await paletteClosed();
    await user.see(changeModel, { text: /^BYOK witness$/ });
    await user.screenshot();
  });

  await step("after: Next pinned model in the palette, then its Control+Shift+M key, each move to the next pinned model", async () => {
    await openPalette("next pinned");
    const nextRow = (await texts(item("models.next-pinned")))[0] ?? "";
    const target = /→ (.+?)\s*(?:⌃⇧M|Ctrl\+Shift\+M)$/.exec(nextRow)?.[1]?.trim() ?? "";
    expect(nextRow).toContain("BYOK witness → ");
    expect(target).not.toBe("");
    await user.click({ role: "option", label: /^Next pinned model/ });
    await paletteClosed();
    await user.see(changeModel, { text: new RegExp(`^${escape(target)}$`) });
    const afterPalette = await composerModel();
    await user.press("Control+Shift+M");
    await probe.eventually(composerModel, { within: 10_000, label: "Control+Shift+M moves to the next pinned model", until: (model) => model !== afterPalette });
    const afterKey = await composerModel();
    evidence.recordAssertionEvidence("Next pinned model", `palette: BYOK witness → ${afterPalette}; Control+Shift+M: ${afterPalette} → ${afterKey}`, afterPalette === target && afterKey !== afterPalette);
    expect(afterPalette).toBe(target);
    expect(["Organization witness", "Pinned witness"].filter((pin) => pin !== afterPalette)).toContain(afterKey);
    await user.screenshot();
  });
});

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
