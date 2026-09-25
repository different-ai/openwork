import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { reviewBrowserWorld } from "../worlds/evidence-review.ts";

const test = spec.world((seed, context) => reviewBrowserWorld(seed, context, true), {
  resources: { surfaces: ["appWeb"], services: [] }, needs: { placement: "local" },
});

test("a reviewer keeps the screenshot when a checkpoint is unavailable or expired", async ({ world, user, probe, step, evidence }) => {
  await step("before: ordinary evidence images do not promise an interactive browser", async () => {
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "link", label: "Inspect Share link dialog · fixture" });
    await user.notSee({ role: "button", text: "Open from here" }, { timeoutMs: 500 });
    evidence.recordAssertionEvidence("Ordinary screenshots stay ordinary", "The reference image has no checkpoint action. Synthetic report fixture; no VM is claimed.", true);
    await user.screenshot();
  });
  await step("after: missing checkpoint configuration names the owner who can fix it", async () => {
    await user.press("Escape");
    await user.click({ role: "link", label: "Inspect Unavailable checkpoint fixture" });
    await user.see({ text: "Checkpoint access is not configured. Contact the review app owner." });
    expect((await probe.dom(".viewer-context section[aria-label='Interactive checkpoint'] button:disabled")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Unavailable actions remain visible", "Open from here is disabled and names the review app owner. No live provider credential is supplied in this fixture.", true);
    await user.screenshot();
  });
  await step("after: expired checkpoints retain their original screenshot", async () => {
    await user.press("Escape");
    await user.click({ role: "link", label: "Inspect Expired checkpoint fixture" });
    await user.see({ text: "Checkpoint expired. Screenshot only." });
    expect((await probe.dom(".viewer-image img")).elements).toHaveLength(1);
    expect((await probe.dom(".viewer-context section[aria-label='Interactive checkpoint'] button:disabled")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Expiry does not delete evidence", "The image remains visible while the expired checkpoint is disabled. This fixture tests rendering, not actual VM expiry.", true);
    await user.screenshot();
  });
});
