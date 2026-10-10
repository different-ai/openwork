import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelPicker } from "../worlds/chat.ts";

const test = spec.world(modelPicker, {
  timeout: 420_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("Connect a provider shows each provider with only what it needs: no status words, and Connect only where nothing is added yet", async ({ user, probe, step, evidence }) => {
  const dialog = '[role="dialog"]';
  const dialogText = async () => (await probe.dom(dialog)).elements[0]?.text ?? "";

  await step("before: the member opens Connect a provider from the model picker", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: "Connect more providers" });
    await user.see({ text: "Adds a key to this device only." });
    await user.see({ label: "Search providers" });
    expect(await dialogText()).toMatch(/^Connect a provider/);
    await user.screenshot();
  });

  await step("after: OpenWork Models carries no Included, Free, or limit labels, nothing reads Connected, and only providers not yet added say Connect", async () => {
    const text = await dialogText();
    for (const word of ["Connected", "Included", "No account needed", "weekly limit"]) expect(text).not.toContain(word);
    // "Free" only as Auto's old copy; a catalog provider may itself be named FreeModel.
    expect(text).not.toMatch(/Free ·|· Free/);
    await user.see({ testId: "included-openwork-provider" }, { text: /^OpenWork Models\s*Auto$/ });
    // Every provider still to add ends with the one Connect action.
    const available = (await probe.dom(`${dialog} [aria-labelledby="connect-provider-available"] button[data-provider-id]`)).elements;
    expect(available.length).toBeGreaterThan(0);
    const statusWords = ["Connected", "Included", "No account needed", "weekly limit"].filter((word) => text.includes(word));
    evidence.recordAssertionEvidence("Connect a provider shows no status words and offers Connect only on providers not yet added",
      `status words found: ${statusWords.join(", ") || "none"}; ${available.length} providers to add, all ending in Connect`,
      statusWords.length === 0 && available.length > 0 && available.every((provider) => /Connect$/.test(provider.text)));
    for (const provider of available) expect(provider.text).toMatch(/Connect$/);
    await user.screenshot();
  });
});
