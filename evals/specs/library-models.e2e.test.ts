import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryModels } from "../worlds/library-models.ts";

const test = spec.world(libraryModels, { timeout: 420_000, resources: { surfaces: ["appWeb"], services: [] } });

// Models live in the Library next to connectors, skills and plugins, so a
// person can answer "which models can I use?" without opening the picker.
test("a person: I want to know which models I can use, so I open Library and choose Models", async ({ user, agent, probe, step, evidence }) => {
  await step("before: the Library lists connectors, skills and plugins, with Models as its own chip", async () => {
    await agent.run("route.extensions.skills");
    await user.see({ role: "button", label: "Models" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "All" });
    const headers = (await probe.dom("[data-library-section] h2")).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("section headers read in sentence case", headers.join(" / "), headers.every((text) => text !== text.toUpperCase()));
    await user.screenshot();
  });

  await step("after: Models lists each provider with its model names, under where it comes from", async () => {
    await user.click({ role: "button", label: "Models" });
    await user.see({ text: "Studio Llama" }, { timeoutMs: 60_000 });
    await user.see({ text: "Studio Router" });
    await user.see({ text: "Llama 3.2 Small, Llama 3.3 Large" });
    const onThisComputer = (await probe.dom('[data-library-section="mac"] [data-library-row]')).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("both providers sit under On this computer", onThisComputer.join(" | "), onThisComputer.some((text) => text.startsWith("Studio Llama")) && onThisComputer.some((text) => text.startsWith("Studio Router")));
    expect(onThisComputer.some((text) => text.startsWith("Studio Llama"))).toBe(true);
    await user.notSee({ text: "Slack" });
    await user.screenshot();
  });

  await step("typing a model name finds the provider that has it", async () => {
    await user.type({ placeholder: "Filter by name" }, "gemini");
    await user.see({ text: "Studio Router" }, { timeoutMs: 15_000 });
    await user.notSee({ text: "Studio Llama" });
    await user.screenshot();
    await user.type({ placeholder: "Filter by name" }, "", { replace: true });
  });

  await step("a provider's page lists every model with who made it", async () => {
    await user.click({ text: "Studio Router" });
    await user.see({ testId: "library-model-page" }, { timeoutMs: 30_000 });
    await user.see({ testId: "library-model-state" }, { text: "Set up on this computer." });
    await user.see({ testId: "library-model-list" }, { text: /2 models/ });
    const rows = (await probe.dom('[data-testid="library-model-row"]')).elements.map((element) => element.text.replace(/\s+/g, ""));
    const expected = ["ClaudeSonnet4.5Anthropic", "Gemini2.5FlashGoogle"];
    evidence.recordAssertionEvidence("each model says who made it", "Claude Sonnet 4.5: Anthropic; Gemini 2.5 Flash: Google", expected.every((row) => rows.includes(row)));
    expect(rows).toEqual(expected);
    await user.see({ text: "Technical details" });
    await user.screenshot();
  });

  await step("Add to library under Models opens the existing add-a-provider flow", async () => {
    await user.click({ role: "button", label: "Back to Library" });
    await user.see({ text: "Studio Llama" }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: "Add to library" });
    await user.see({ text: "Connect providers" }, { timeoutMs: 15_000 });
    await user.screenshot();
  });
});
