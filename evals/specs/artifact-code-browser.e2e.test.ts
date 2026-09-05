import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { artifactCodeBrowserWorld } from "../worlds/first-run.ts";

const test = spec.world(artifactCodeBrowserWorld);

test("artifact editor renders code with Pierre and browses workspace files", async ({ world, user, step, evidence }) => {
  await user.click("Select tab: overflow-tab-12.md");
  await user.see({ placeholder: "Search files" }, { timeoutMs: 30_000 });

  await step("A TypeScript file opens beside the workspace tree", async () => {
    await user.type({ placeholder: "Search files" }, "openwork-artifact-proof.ts");
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Enter");
    await user.see("Select tab: openwork-artifact-proof.ts", { timeoutMs: 30_000 });
    // Pierre renders code inside a shadow root, outside the generic text locator.
    const code = await eventually(() => world.visibleArtifactCode(), {
      within: 30_000,
      until: (value) => typeof value === "string" && value.includes("export const artifactEditor = true"),
    });
    expect(code).toContain("export const artifactEditor = true");
    await user.looks([
      "The artifact panel visibly shows a workspace file tree beside a syntax-highlighted TypeScript code viewer",
      "The code viewer visibly contains the TypeScript declaration export const artifactEditor = true",
      "No error dialog, blank artifact surface, or crash message is visible",
    ]);
  });

  await step("Restricted folders show an honest notice while readable files remain usable", async () => {
    await world.setCatalogFolderRestricted(true);
    try {
      await user.click("Refresh workspace files");
      await user.see({ text: "Some folders could not be read. Check their permissions and refresh." });
      await user.see("Select tab: openwork-artifact-proof.ts");
      await user.notSee({ text: "Could not load workspace files." });
      evidence.recordAssertionEvidence("The file browser reports a permission gap without replacing readable files with an error", "After restricting a synthetic sibling folder and refreshing, the permissions notice and readable artifact tab remained visible, with no catalog load error.", true);
    } finally {
      await world.setCatalogFolderRestricted(false);
    }
    await user.click("Refresh workspace files");
    await user.notSee({ text: "Some folders could not be read. Check their permissions and refresh." });
    evidence.recordAssertionEvidence("The partial-catalog notice clears after restoring permissions", "Restoring the synthetic folder's permissions and using the refresh button removed the notice.", true);
  });

  await step("Selecting JSON replaces the active code artifact", async () => {
    await user.type({ placeholder: "Search files" }, "openwork-artifact-settings.json", { replace: true });
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Enter");
    await user.see("Select tab: openwork-artifact-settings.json", { timeoutMs: 30_000 });
    await user.looks([
      "The artifact panel visibly shows the workspace file tree beside a syntax-highlighted JSON code viewer",
      "The code viewer visibly contains the JSON property artifactEditor set to true, and no TypeScript declaration is visible",
      "No error dialog, blank artifact surface, or crash message is visible",
    ]);
  });
});
