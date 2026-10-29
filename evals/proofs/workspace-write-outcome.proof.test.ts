import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workspaceWriteOutcome } from "../worlds/workspace-write-outcome.ts";

const test = spec.world(workspaceWriteOutcome, {
  resources: { surfaces: ["appWeb"], services: ["mock"] }, timeout: 300_000,
});

test("a person sees a failed report write as failed, and a saved report as saved", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const capture = async () => {
    const layout = await probe.dom("body");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.elements.every(element => element.rect.width > 0 && element.rect.height > 0)).toBe(true);
    await user.notSee({ role: "dialog" });
    await user.screenshot();
  };
  let failedSession = "";
  await step("a denied report write creates no workspace file", async () => {
    await user.reload();
    failedSession = world.sessionIds[0];
    await user.navigate(world.sessionUrls[0]);
    await user.see("composer", { editable: true });
    await user.click({ role: "button", label: "Change model" });
    await user.type({ role: "combobox", label: "Search all models" }, "Report model");
    await user.click({ role: "option", label: /^Report model, Workspace proof/ });
    await user.type("composer", world.failedPrompt);
    await user.click("Run task");
    await user.see({ text: "Access an external folder?" }, { timeoutMs: 60_000 });
    await user.click("Deny");
    await user.see({ text: "The user rejected permission to use this specific tool call." }, { timeoutMs: 30_000 });
    const writes = await world.writes(failedSession);
    const content = await world.fileContent();
    evidence.recordAssertionEvidence("The engine refused the write and no report was saved", `write=${writes.join(",")}; workspace file=${content !== null}`, writes.includes("error") && content === null);
    expect(writes).toContain("error");
    expect(content).toBeNull();
    await capture();
  });

  await step("after: the failed write says Write failed rather than Wrote, including after reopening", async () => {
    await user.reload();
    await user.see({ text: "Write failed:" }, { timeoutMs: 30_000 });
    const rows = await probe.dom('[data-tool-aggregate][data-tool-lifecycle="failed"]');
    expect(rows.elements.some(row => row.text.includes("Write failed:"))).toBe(true);
    expect(rows.elements.some(row => /\bWrote\b/.test(row.text))).toBe(false);
    evidence.recordAssertionEvidence("The failed tool row remains truthful after reload", rows.elements.map(row => row.text).join("; "), rows.elements.some(row => row.text.includes("Write failed:")) && rows.elements.every(row => !/\bWrote\b/.test(row.text)));
    await capture();
  });

  await step("a successful retry saves the report in the workspace and still says Wrote", async () => {
    const successSession = world.sessionIds[1];
    await user.navigate(world.sessionUrls[1]);
    await user.click({ role: "button", label: "Change model" });
    await user.type({ role: "combobox", label: "Search all models" }, "Report model");
    await user.click({ role: "option", label: /^Report model, Workspace proof/ });
    await user.type("composer", world.successPrompt);
    await user.click("Run task");
    await user.see({ text: world.successReply }, { timeoutMs: 60_000 });
    await user.see({ text: "Wrote" });
    const writes = await world.writes(successSession);
    const content = await world.fileContent();
    evidence.recordAssertionEvidence("The successful write and workspace file agree", `write=${writes.join(",")}; content matches=${content === world.content}`, writes.includes("completed") && content === world.content);
    expect(writes).toContain("completed");
    expect(content).toBe(world.content);
    await user.see({ text: "Workspace destination:" });
    const destinations = await probe.dom("[data-workspace-file-resolution]");
    expect(destinations.elements.some(row => row.text.includes(world.destination))).toBe(true);
    evidence.recordAssertionEvidence("The relative write shows its actual workspace destination", destinations.elements.map(row => row.text).join("; "), destinations.elements.some(row => row.text.includes(world.destination)));
    await capture();
  });
});
