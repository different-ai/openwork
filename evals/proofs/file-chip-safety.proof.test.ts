import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { fileChipPrompt, fileChipSafety } from "../worlds/file-chip-safety.ts";

const test = spec.world(fileChipSafety, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["mock"] }, needs: { commands: ["bun"] },
});

test("a person using the web app can preview and copy a file reference without a misleading native launch action", async ({ user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("the report read produces a file chip in the conversation", async () => {
    await user.type("composer", fileChipPrompt);
    await user.click("Run task");
    await user.see({ text: "The report is ready for review." }, { timeoutMs: 120_000 });
    await user.see({ role: "button", label: "report.md" });
    const chips = (await probe.dom("[data-tool-aggregate] button[title]")).elements;
    evidence.recordAssertionEvidence("A genuine file read is represented by its file reference", `${chips.length} file-chip buttons in the activity rail`, chips.length > 0);
    expect(chips.length).toBeGreaterThan(0);
    await user.screenshot();
  });
  await step("after: the reference menu keeps Copy path but offers no desktop action in the browser", async () => {
    await user.rightClick({ role: "button", label: "report.md" });
    await user.see({ role: "menuitem", label: "Copy path" });
    await user.notSee({ role: "menuitem", label: "Open in default app" });
    await user.notSee({ role: "button", label: /^Open in default app:/ });
    const menu = await probe.text();
    expect(menu).toContain("Copy path");
    expect(menu).not.toContain("Open in default app");
    evidence.recordAssertionEvidence("Web references remain usable without pretending the worker path is local", "Copy path and Open file remain; no native app launch or hover action", menu.includes("Copy path") && !menu.includes("Open in default app"));
    await user.screenshot();
    await user.press("Escape");
  });
  await step("the person opens the same reference in the workspace preview", async () => {
    await user.click({ role: "button", label: "report.md" });
    await user.see({ text: "A preserved local report." }, { timeoutMs: 30_000 });
    await user.click("Artifact actions");
    await user.see({ role: "menuitem", label: "Download" });
    await user.notSee({ role: "menuitem", label: "Open externally" });
    const preview = await probe.text();
    expect(preview).toContain("A preserved local report.");
    expect(preview).toContain("Download");
    evidence.recordAssertionEvidence("The workspace preview and download still work", "Report contents visible and Download available; no native file-manager actions", preview.includes("A preserved local report.") && preview.includes("Download"));
    await user.screenshot();
  });
});
