import { spec } from "@openwork/testkit";
import { artifactCodeBrowserWorld } from "../worlds/first-run.ts";

const test = spec.world(artifactCodeBrowserWorld);

test("artifact editor renders code with Pierre and browses workspace files", async ({ user, step }) => {
  await user.click("Select tab: overflow-tab-12.md");
  await user.see({ placeholder: "Search files" }, { timeoutMs: 30_000 });

  await step("A TypeScript file opens beside the workspace tree", async () => {
    await user.type({ placeholder: "Search files" }, "openwork-artifact-proof.ts");
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Enter");
    await user.see("Select tab: openwork-artifact-proof.ts", { timeoutMs: 30_000 });
    await user.see({ text: /export const artifactEditor = true/ }, { timeoutMs: 30_000 });
    await user.looks([
      "The artifact panel visibly shows a workspace file tree beside a syntax-highlighted TypeScript code viewer",
      "The code viewer visibly contains the TypeScript declaration export const artifactEditor = true",
      "No error dialog, blank artifact surface, or crash message is visible",
    ]);
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
