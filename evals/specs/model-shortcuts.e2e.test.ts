import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { fastVariantId } from "@openwork/types/cloud-model-fast";

import { modelShortcutsWeb } from "../worlds/model-shortcuts.ts";

const test = spec.world(modelShortcutsWeb, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

type RowSnapshot = { elements: Array<{ text: string; attributes?: Record<string, string> }> };

const rowTexts = (snapshot: RowSnapshot) => snapshot.elements.map((element) => element.text.replace(/\s+/g, " ").trim());

test("a member switches models with saved keys and toggles Fast without opening a notice above the composer", async ({ world, user, probe, step, evidence }) => {
  const { mod, chord, fastKey } = world;
  evidence.recordAssertionEvidence("platform keys", `${mod}+Alt+n shown as ${chord(1)}`, true);
  const openShortcutSettings = async () => {
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness/, timeoutMs: 60_000 });
    await user.click("composer");
    await user.press(`${mod}+K`);
    await user.type({ placeholder: "Search actions and settings…" }, "Keyboard shortcuts");
    await user.click({ role: "option", label: /^Keyboard shortcuts/ });
    await user.see({ text: "Model shortcuts" });
  };

  await step("before: Settings shows the key saved for a retired model, still there and marked as no longer offered", async () => {
    await openShortcutSettings();
    const rows = await probe.eventually(() => probe.dom('[data-testid="model-shortcut-row"]'), {
      within: 30_000, label: "retired shortcut row", until: (snapshot) => rowTexts(snapshot).some((text) => text.includes("No longer offered")),
    });
    evidence.recordAssertionEvidence("saved shortcut rows", rowTexts(rows).join(" | "), rowTexts(rows).length === 1);
    expect(rowTexts(rows)).toHaveLength(1);
    expect(rowTexts(rows)[0]).toContain("Retired witness");
    expect(rowTexts(rows)[0]).toContain(chord(9));
    await user.screenshot();
  });

  await step("the member adds a key for Fast witness at High reasoning with Fast on", async () => {
    await user.click({ role: "button", label: "Add model shortcut" });
    await user.click({ role: "combobox", label: "Model" });
    await user.click({ role: "option", label: "Fast witness" });
    await user.click({ role: "button", label: "High" });
    await user.see({ text: "Higher pricing" });
    await user.click({ role: "switch", label: "Fast" });
    await user.see({ role: "button", label: new RegExp(`Key ${escape(chord(1))}`) });
    await user.screenshot();
    await user.click({ role: "button", label: "Save shortcut" });
    const rows = await probe.eventually(() => probe.dom('[data-testid="model-shortcut-row"]'), {
      within: 10_000, label: "Fast witness row", until: (snapshot) => rowTexts(snapshot).some((text) => text.includes("Fast witness")),
    });
    const fastRow = rowTexts(rows).find((text) => text.includes("Fast witness")) ?? "";
    evidence.recordAssertionEvidence("Fast witness row", fastRow, fastRow.includes("High reasoning") && fastRow.includes("Fast") && fastRow.includes(chord(1)));
    expect(fastRow).toContain("High reasoning");
    expect(fastRow).toContain(chord(1));
  });

  await step("a model without Fast shows Fast as not offered, and a key already in use asks to reassign", async () => {
    await user.click({ role: "button", label: "Add model shortcut" });
    await user.click({ role: "combobox", label: "Model" });
    await user.click({ role: "option", label: "Reasoning witness" });
    await user.see({ text: "Not offered for this model" });
    await user.click({ role: "button", label: "High" });
    await user.click({ role: "button", label: /Change key|Record a key/ });
    await user.press(`${mod}+Alt+1`);
    await user.see({ text: `${chord(1)} opens Fast witness` });
    await user.see({ role: "button", label: "Reassign" });
    await user.screenshot();
    await user.click({ role: "button", label: /Change key/ });
    await user.press(`${mod}+Alt+2`);
    await user.click({ role: "button", label: "Save shortcut" });
    const rows = await probe.eventually(() => probe.dom('[data-testid="model-shortcut-row"]'), {
      within: 10_000, label: "three shortcut rows", until: (snapshot) => rowTexts(snapshot).length === 3,
    });
    evidence.recordAssertionEvidence("saved shortcut rows", rowTexts(rows).join(" | "), rowTexts(rows).length === 3);
    expect(rowTexts(rows).find((text) => text.includes("Reasoning witness"))).toContain(chord(2));
    expect(rowTexts(rows).find((text) => text.includes("Fast witness"))).toContain(chord(1));
    await user.screenshot();
  });

  await user.click({ role: "button", label: "Back to app" });
  await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness/, timeoutMs: 60_000 });

  await step("after: in the conversation one key press switches to Fast witness at High with Fast", async () => {
    await user.press(`${mod}+Alt+1`);
    await user.notSee({ testId: "model-shortcut-notice" });
    await user.see({ role: "button", label: "Change model" }, { text: /^Fast witness/ });
    const stored = await probe.storage("openwork.sessionModels.v1");
    const serialized = JSON.stringify(stored);
    evidence.recordAssertionEvidence("conversation model", serialized.slice(0, 300), serialized.includes(fastVariantId("high")));
    expect(serialized).toContain(world.fastModelId);
    expect(serialized).toContain(fastVariantId("high"));
    await user.screenshot();
  });

  await step("the second key switches to Reasoning witness at High, and the first key switches straight back", async () => {
    await user.press(`${mod}+Alt+2`);
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness/ });
    await user.notSee({ testId: "model-shortcut-notice" });
    await user.screenshot();
    await user.press(`${mod}+Alt+1`);
    await user.see({ role: "button", label: "Change model" }, { text: /^Fast witness/ });
    evidence.recordAssertionEvidence("first key again", "composer shows Fast witness again without an intermediate notice", true);
  });

  await step("the default Fast key turns Fast off and back on for Fast witness, keeping High, and the model shows a quiet Fast", async () => {
    await user.see({ testId: "model-fast-indicator" }, { text: /Fast/ });
    await user.press(fastKey);
    await user.notSee({ testId: "model-fast-indicator" });
    await user.see({ role: "button", label: "Change model" }, { text: /^Fast witness\s*· High$/ });
    await user.screenshot();
    await user.press(fastKey);
    await user.see({ testId: "model-fast-indicator" }, { text: /Fast/ });
    await user.see({ role: "button", label: "Change model" }, { text: /^Fast witness\s*· High\s*· Fast$/ });
    await user.notSee({ testId: "model-shortcut-notice" });
    const stored = JSON.stringify(await probe.storage("openwork.sessionModels.v1"));
    evidence.recordAssertionEvidence("Fast back on at High", stored.slice(0, 300), stored.includes(fastVariantId("high")));
    expect(stored).toContain(fastVariantId("high"));
    await user.screenshot();
  });

  await step("on a model without Fast, the Fast key quietly changes nothing", async () => {
    await user.press(`${mod}+Alt+2`);
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness/ });
    const before = JSON.stringify(await probe.storage("openwork.sessionModels.v1"));
    await user.press(fastKey);
    await user.notSee({ testId: "model-fast-indicator" });
    await user.notSee({ testId: "model-shortcut-notice" });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness\s*· High$/ });
    const after = JSON.stringify(await probe.storage("openwork.sessionModels.v1"));
    evidence.recordAssertionEvidence("model unchanged", "composer still shows Reasoning witness · High and stored selection is unchanged", before === after);
    expect(after).toBe(before);
    await user.screenshot();
  });

  await step("after: the retired model's key quietly leaves the current model alone and is not deleted", async () => {
    await user.press(`${mod}+Alt+9`);
    await user.notSee({ testId: "model-shortcut-notice" });
    await user.see({ role: "button", label: "Change model" }, { text: /^Reasoning witness/ });
    const stored = JSON.stringify(await probe.storage("openwork.shortcuts.v1"));
    const kept = stored.includes("sc_retired");
    evidence.recordAssertionEvidence("retired shortcut still saved", kept ? "openwork.shortcuts.v1 still contains the Retired witness key" : stored.slice(0, 300), kept);
    expect(kept).toBe(true);
    await user.screenshot();
  });
});

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
