import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotPreview } from "../worlds/workbot-preview.ts";

const test = spec.world(workbotPreview, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a member can distinguish attachment excerpts from the complete original download", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("after: the spreadsheet preview names its row limit", async () => {
    await user.click({ role: "button", label: /Table.csv/ });
    await user.see({ text: /Showing the first 1,000 of 1,006 rows/ }, { timeoutMs: 5000 });
    await user.notSee({ text: "Row 1005" });
    evidence.recordAssertionEvidence("The grid is a bounded read-only preview", "1,000 of 1,006 rows are shown; the original remains downloadable", (await probe.text()).includes("1,006 rows"));
    await user.screenshot();
    await user.click({ role: "button", label: "Close preview" });
  });
  await step("slide text is labeled as extracted without inventing a slide layout", async () => {
    await user.click({ role: "button", label: /Review.pptx/ });
    await user.see({ text: /Extracted text excerpt, up to 24,000 characters/ });
    await user.see({ text: /Point 12/ });
    await user.notSee({ role: "textbox", label: /slide|document/i });
    evidence.recordAssertionEvidence("Extracted words do not pretend to be the original slide layout", "The excerpt labels missing layout and images; Point 12 remains visible", (await probe.text()).includes("Point 12"));
    await user.screenshot();
    await user.click({ role: "button", label: "Close preview" });
  });
  await step("a failed download preserves the labeled text excerpt and offers another attempt", async () => {
    await user.click({ role: "button", label: /Notes.txt/ });
    await user.see({ text: /Excerpt: first 2,000,000 of/ });
    world.denyDownload();
    await user.click({ role: "button", label: "Download original" });
    await user.see({ text: "Couldn't download. Try again." });
    evidence.recordAssertionEvidence("A failed original download is not reported as success", "The byte-limited excerpt stays visible beside a download failure", (await probe.text()).includes("Couldn't download. Try again."));
    await user.screenshot();
  });
  await step("the original download includes every byte beyond the text preview", async () => {
    world.restoreDownload();
    await user.click({ role: "button", label: "Download original" });
    const downloaded = await probe.eventually(() => world.originalDownloaded(), { within: 8000, label: "the complete original is saved by the browser", until: value => value?.complete === true });
    expect(downloaded?.length).toBeGreaterThan(2_000_000);
    expect(downloaded?.complete).toBe(true);
    evidence.recordAssertionEvidence("Download original saves bytes beyond the visible excerpt", JSON.stringify(downloaded), downloaded?.complete === true);
    await user.screenshot();
  });
});
