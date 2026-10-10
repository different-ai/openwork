import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { artifactCodeBrowserWorld } from "../worlds/first-run.ts";

const test = spec.world(artifactCodeBrowserWorld);

test("artifact editor renders code with Pierre and browses workspace files", async ({ world, user, probe, step, evidence, place }) => {
  const expectCodeBesideTree = async (language: string) => {
    const [tree] = (await probe.dom("[data-workspace-file-tree]")).elements;
    const [viewer] = (await probe.dom("[data-artifact-code-view]")).elements;
    if (!tree || !viewer) throw new Error("The workspace tree and code viewer must both be mounted.");
    expect(tree.rect.width).toBeGreaterThan(0);
    expect(tree.rect.height).toBeGreaterThan(0);
    expect(viewer.rect.width).toBeGreaterThan(0);
    expect(viewer.rect.height).toBeGreaterThan(0);
    expect(tree.rect.right).toBeLessThanOrEqual(viewer.rect.left + 1);
    expect(Math.max(tree.rect.top, viewer.rect.top)).toBeLessThan(Math.min(tree.rect.bottom, viewer.rect.bottom));
    const presentation = await probe.eventually(() => world.artifactCodePresentation(), {
      within: 10_000,
      label: "the code viewer has visible syntax-highlighted tokens",
      until: (value) => value.colors.length > 1,
    });
    expect(presentation.error).toBeNull();
    await user.notSee({ role: "alert" });
    expect((await probe.dom('[role="dialog"], dialog[open]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence(`The workspace tree sits beside highlighted ${language} code`,
      `Tree width ${tree.rect.width}px; code viewer width ${viewer.rect.width}px; ${presentation.colors.length} visible token colors; no render error, alert, or dialog.`, true);
    await user.screenshot();
  };

  await step("An artifact opens with workspace files collapsed", async () => {
    await user.click("Select tab: overflow-tab-12.md");
    await user.see({ role: "button", label: "Show workspace files" });
    await user.notSee({ placeholder: "Search files" });
    await user.screenshot();
  });

  await step("A TypeScript file opens beside the workspace tree", async () => {
    await user.click({ role: "button", label: "Show workspace files" });
    await user.see({ placeholder: "Search files" }, { timeoutMs: 30_000 });
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
    evidence.recordAssertionEvidence("The TypeScript file shows its declaration", "The visible code contains export const artifactEditor = true.", true);
    await expectCodeBesideTree("TypeScript");
  });

  await step("Workspace files can be hidden and reopened while the artifact stays visible", async () => {
    await user.click({ role: "button", label: "Hide workspace files" });
    await user.see({ role: "button", label: "Show workspace files" });
    await user.notSee({ placeholder: "Search files" });
    expect(await world.visibleArtifactCode()).toContain("export const artifactEditor = true");
    await user.screenshot();
    await user.click({ role: "button", label: "Show workspace files" });
    await user.see({ placeholder: "Search files" });
    expect(await world.visibleArtifactCode()).toContain("export const artifactEditor = true");
    await user.screenshot();
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
    await probe.eventually(() => probe.dom('[data-workspace-file-tree] [role="status"]'), {
      within: 10_000,
      label: "the partial-catalog notice clears after refresh",
      until: ({ elements }) => elements.length === 0,
    });
    await user.notSee({ text: "Some folders could not be read. Check their permissions and refresh." });
    evidence.recordAssertionEvidence("The partial-catalog notice clears after restoring permissions", "Restoring the synthetic folder's permissions and using the refresh button removed the notice.", true);
  });

  await step("Selecting JSON replaces the active code artifact", async () => {
    await user.type({ placeholder: "Search files" }, "openwork-artifact-settings.json", { replace: true });
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Enter");
    await user.see("Select tab: openwork-artifact-settings.json", { timeoutMs: 30_000 });
    // Read exact code through Pierre's shadow root instead of OCR on wrapped text.
    const code = await probe.eventually(() => world.visibleArtifactCode(), {
      within: 30_000,
      label: "the JSON content replaces the TypeScript content",
      until: (value) => value.includes('{"artifactEditor":true}') && !value.includes("export const artifactEditor"),
    });
    expect(code).toContain('{"artifactEditor":true}');
    expect(code).not.toContain("export const artifactEditor");
    evidence.recordAssertionEvidence("The JSON file replaces the TypeScript content", 'The code viewer contains {"artifactEditor":true} and no export const artifactEditor declaration.', true);
    await expectCodeBesideTree("JSON");
  });

  await step("table context clicks preserve the preview; a plain cell click edits only its source row", async () => {
    await user.type({ placeholder: "Search files" }, "table-interactions.md", { replace: true });
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Enter");
    await user.see("Select tab: table-interactions.md", { timeoutMs: 30_000 });
    await user.click({ role: "button", label: "Edit" });
    await user.see({ text: "Second row" });
    const filePath = `/workspace/${world.workspace.workspaceId}/files/content?path=docs%2Ftable-interactions.md`;
    const expectContent = async (content: string) => probe.eventually(async () => {
      const response = await probe.desktopApi(filePath);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ content });
      return true;
    }, { within: 10_000, label: "only the intended table source is saved" });

    for (const target of [{ text: "Second row" }, { role: "link", label: "Documentation" }] satisfies Parameters<typeof user.rightClick>[0][]) {
      await user.rightClick(target);
      await probe.eventually(async () => {
        expect(await world.nativeMenu()).toMatchObject({ open: true });
        return true;
      }, { within: 10_000, label: "the native table menu opens" });
      expect((await probe.dom(".cm-md-table table")).elements).toHaveLength(1);
      // CDP Escape targets the page and closes the artifact panel, not the OS menu.
      expect(await world.dismissMenu()).toBe(true);
      expect(await world.nativeMenu()).toMatchObject({ open: false, last: { selectedId: null } });
      expect((await probe.dom(".cm-md-table table")).elements).toHaveLength(1);
      await expectContent(world.tableMarkdown);
    }

    await user.click({ text: "Second row" });
    expect((await probe.dom(".cm-md-table")).elements).toHaveLength(0);
    await user.press("Delete");
    await expectContent(world.tableMarkdown.replace("| Second row", " Second row"));
    await user.press(place.kind === "local" && process.platform === "darwin" ? "Meta+Z" : "Control+Z");
    await expectContent(world.tableMarkdown);
    await user.click({ role: "button", label: "Done" });
    await user.see({ text: "Second row" });
    await user.see({ role: "link", label: "Documentation" });
  });

  await step("Unlisted chat files expose exact paths through right-click and keyboard actions", async () => {
    await user.rightClick({ role: "link", label: "Unlisted report" });
    await user.see({ role: "button", label: "Copy path" });
    await user.see({ role: "button", label: place.kind === "local" && process.platform === "darwin" ? "Reveal in Finder" : "Show in folder" });
    await user.click({ role: "button", label: "Copy path" });
    await user.click("composer");
    await user.press(place.kind === "local" && process.platform === "darwin" ? "Meta+V" : "Control+V");
    await user.see("composer", { text: world.fileLinkPath });
    await user.type("composer", "", { replace: true });
    await user.rightClick({ role: "link", label: "Relative report" });
    await user.press("Escape");
    await user.click({ role: "button", label: "Open with", nth: 1 });
    await user.press("Enter");
    await user.click("composer");
    await user.press(place.kind === "local" && process.platform === "darwin" ? "Meta+V" : "Control+V");
    await user.see("composer", { text: `${world.workspacePath}/docs/Unlisted-Relative.pdf` });
    await user.type("composer", "", { replace: true });
    await user.click({ role: "button", label: "Open with", nth: 1 });
    await user.press("Escape");
    await user.press("Enter");
    await user.see({ role: "button", label: "Copy path" });
    await user.press("Escape");
  });
});
