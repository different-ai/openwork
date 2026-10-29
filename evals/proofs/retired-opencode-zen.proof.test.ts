import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { retiredOpencodeZen } from "../worlds/retired-opencode-zen.ts";

const test = spec.world(retiredOpencodeZen, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun"] },
});
const WITHIN = 60_000;

test("a person looking for OpenCode Zen is told it is no longer offered instead of finding nothing", async ({ world, user, probe, step, evidence }) => {
  const retiredRow = async () => (await probe.dom('[data-testid="retired-opencode-zen"]')).elements.map(element => element.text).join(" ");
  const zenEntries = async () => (await probe.dom('[role="dialog"] [data-provider-id="opencode"]')).elements.length;
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("after: searching Connect a provider for OpenCode shows Zen marked No longer offered, next to OpenCode Go", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "opencode");
    const text = await probe.eventually(retiredRow, { within: WITHIN, label: "the retired OpenCode Zen row", until: value => value.includes("No longer offered") });
    expect(text).toContain("OpenCode Zen");
    expect(text).toContain("OpenCode Go");
    evidence.recordAssertionEvidence("Zen is present with a lock and the next step, not silently missing", text, text.includes("No longer offered") && text.includes("OpenCode Go"));
    await user.screenshot();
  });

  await step("searching for Zen finds the retired row, not an empty list", async () => {
    await user.type({ label: "Search providers" }, "zen", { replace: true });
    const text = await probe.eventually(retiredRow, { within: WITHIN, label: "the retired row for a Zen search", until: value => value.includes("No longer offered") });
    await user.notSee({ text: "No providers match your search." });
    evidence.recordAssertionEvidence("A search for Zen explains the retirement", text, text.includes("OpenCode Zen"));
    await user.screenshot();
  });

  await step("a search for another provider does not show the Zen row, and Zen still cannot be connected", async () => {
    await user.type({ label: "Search providers" }, "openai", { replace: true });
    await user.see({ role: "button", label: /^OpenAI/ }, { timeoutMs: WITHIN });
    const text = await retiredRow();
    const zen = await zenEntries();
    expect(text).toBe("");
    expect(zen).toBe(0);
    evidence.recordAssertionEvidence("Only Zen searches show the notice; Zen is not connectable", `retired row="${text}"; connectable Zen entries=${zen}`, text === "" && zen === 0);
    await user.screenshot();
  });
});
