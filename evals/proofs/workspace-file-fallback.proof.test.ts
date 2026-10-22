import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { producedFileV2PathFreeEvidence, producedFileV2Prompt } from "../worlds/produced-file-evidence.ts";

const test = spec.world(producedFileV2PathFreeEvidence, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

// Automatic discovery is still unsupported for this path-free native result.
// The recovery is a real scoped workspace browser, not an invented file card.
test("a person can find an unreported native output without mistaking conversation references for all workspace files", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the native shell writes a real summary without a path or link in the reply", async () => {
    await user.type("composer", producedFileV2Prompt);
    await user.click("Run task");
    await user.see({ text: "Voilà." }, { timeoutMs: 120_000 });
    await user.see({ role: "button", label: "Referenced files (0)" });
    await user.notSee("Close artifact");
    const summary = await world.summary();
    expect(summary).toContain("The requested summary.");
    const trees = (await probe.dom("[data-workspace-file-tree]")).elements;
    expect(trees).toHaveLength(0);
    evidence.recordAssertionEvidence("The actual output exists without an automatic preview or fabricated reference", "summary.md exists; reply only says Voilà; Referenced files (0); workspace browser not opened", summary.includes("The requested summary.") && trees.length === 0);
    await user.screenshot();
  });
  await step("after: the empty reference list does not claim there are no produced files", async () => {
    await user.click({ role: "button", label: "Referenced files (0)" });
    await user.see({ text: "No referenced files available" });
    await user.see({ role: "button", label: "Browse workspace files" });
    const text = await probe.text();
    expect(text).not.toContain("No files or artifacts yet");
    expect(text).not.toContain("will appear here automatically");
    const observed = await world.nativeEvidence();
    expect(observed.tools.length).toBeGreaterThan(0);
    expect(observed.contentTypes.every(type => ["text", "reasoning", "tool"].includes(String(type)))).toBe(true);
    const receiptKeys = observed.tools.flatMap(tool => tool.metadataKeys).filter(key => ["files", "producedFiles", "openworkProducedFiles"].includes(key));
    expect(receiptKeys).toEqual([]);
    evidence.recordAssertionEvidence("The narrow count and explicit browse action remain honest about missing automatic evidence", JSON.stringify(observed), text.includes("No referenced files available") && text.includes("Browse workspace files") && receiptKeys.length === 0);
    await user.screenshot();
  });
  await step("the person explicitly browses and searches the current workspace", async () => {
    await user.click({ role: "button", label: "Browse workspace files" });
    await user.see({ role: "textbox", label: /^Search .* files$/ }, { timeoutMs: 30_000 });
    await user.see({ text: "Browser limits" }, { timeoutMs: 30_000 });
    await user.type({ role: "textbox", label: /^Search .* files$/ }, "summary");
    await user.see({ role: "textbox", label: /^Search .* files$/ }, { value: "summary" });
    const trees = (await probe.dom('[data-workspace-file-tree]:not([data-workspace-file-count="0"])')).elements;
    expect(trees).toHaveLength(1);
    evidence.recordAssertionEvidence("The existing scoped workspace catalog is searched without parsing command text", "The protected catalog has loaded; search contains summary; the next step activates its matching file with trusted keyboard input", trees.length === 1 && (await world.summary()).includes("The requested summary."));
    await user.screenshot();
  });
  await step("the real file opens for preview and download without fabricating a turn association or launching an app", async () => {
    // Pierre renders its rows in Shadow DOM, outside the testkit's ordinary
    // target locator. Use the normal keyboard route: search -> Refresh -> row.
    // Without search, the earlier a-unrelated.md row would open instead.
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Enter");
    await user.see({ text: "The requested summary." }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Referenced files (0)" });
    await user.click("Artifact actions");
    await user.see({ role: "menuitem", label: "Download" });
    await user.notSee({ role: "menuitem", label: "Open externally" });
    const text = await probe.text();
    expect(text).toContain("The requested summary.");
    expect(text).toContain("Download");
    expect(await world.summary()).toBe("# Summary\n\nThe requested summary.\n");
    evidence.recordAssertionEvidence("Manual recovery opens the existing file while the automatic-discovery limitation stays explicit", "Real summary content and Download visible; Referenced files (0) unchanged; original contents unchanged; no native launch action", text.includes("The requested summary.") && text.includes("Download"));
    await user.screenshot();
  });
});
