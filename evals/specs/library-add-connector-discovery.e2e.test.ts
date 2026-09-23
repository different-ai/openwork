import { expect } from "vitest";
import { browserScript, needs, spec, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { libraryConnectorDiscovery } from "../worlds/library.ts";

const test = spec.world(libraryConnectorDiscovery);

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library connector discovery skipped — needs: ${missingRequirements.join(", ")}`
  : "an admin picks what to add in one click and fills it in on a full page, while local MCP creation stays in Advanced";

test(title, async ({ evidence, world, seed, user, probe, step }) => {
  needs(requirements);
  const { app: desktop, workspaceId, organizationId: orgId, denWebUrl } = world;
  await user.see({ text: "OpenWork Cloud account and organization." }, { timeoutMs: 30_000 });
  expect(await probe.storage("openwork.extension.enabled.google-workspace")).toBe(1);
  const settingsText = await probe.text();
  expect(settingsText).toContain("OpenWork Cloud account and organization.");
  expect(settingsText).not.toContain("Google Workspace");
  expect(settingsText).not.toMatch(/Google OAuth|Google Client ID|Google Client Secret/i);
  evidence.recordAssertionEvidence(
    "A stale local Google enabled flag cannot restore legacy Settings setup",
    "The upgraded profile retains openwork.extension.enabled.google-workspace=1. Settings retains the Cloud account entry without restoring Google Workspace or local Google OAuth setup.",
    true,
  );
  const bootstrap = await probe.eval(
    desktop,
    () => (window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig")
      .then((config) => ({
        baseUrl: config.baseUrl,
        activeOrgId: localStorage.getItem("openwork.den.activeOrgId"),
      }))),
    { awaitPromise: true },
  );
  expect(bootstrap).toMatchObject({
    baseUrl: denWebUrl,
    activeOrgId: orgId,
  });

  await step("Ollama has its own Settings page with the existing local model setup", async () => {
    await seed.evalIn(desktop, browserScript((id: string) => {
      location.hash = `#/workspace/${id}/settings/ollama`;
    }, [workspaceId]));
    await user.see({ text: "Connect to Ollama and manage local models" }, { timeoutMs: 30_000 });
    await user.see({ text: "Connect to a local Ollama instance and choose a model." });
    expect(await probe.hash()).toBe(`#/workspace/${workspaceId}/settings/ollama`);
    await user.notSee({ role: "button", label: "Add MCP" });
  });

  await step("Library defaults to MCPs, Ready to use, and cards with only three type filters", async () => {
    // Arrange the surface under test without exercising responsive Settings navigation.
    await seed.evalIn(desktop, browserScript((id: string) => {
      location.hash = `#/workspace/${id}/extensions`;
    }, [workspaceId]));
    await user.see({ role: "button", label: "Add to library" }, { timeoutMs: 90_000 });
    await probe.eventually(() => probe.dom('header button[aria-label="Add to library"]:not(:disabled):not([aria-disabled="true"])'), {
      within: 90_000,
      label: "the signed-in admin's header Add to library is enabled",
      until: (snapshot) => snapshot.elements.length === 1,
    });
    expect(await probe.hash()).toBe(`#/workspace/${workspaceId}/extensions`);
    const filters = await probe.dom('[aria-label="Library filters"] button[aria-pressed]:not([aria-label])');
    expect(filters.elements.map((element) => element.text)).toEqual(["MCPs", "Skills", "Plugins"]);
    expect((await probe.dom('[aria-label="Library filters"] button[aria-pressed="true"]:not([aria-label])')).elements.map((element) => element.text)).toEqual(["MCPs"]);
    expect((await probe.dom('[role="tab"][aria-selected="true"]')).elements).toMatchObject([{ text: expect.stringMatching(/^Ready to use\s*0$/) }]);
    expect((await probe.dom('button[aria-label="Card view"][aria-pressed="true"]')).elements).toHaveLength(1);
    expect((await probe.dom('button[aria-label="List view"][aria-pressed="true"]')).elements).toHaveLength(0);
    expect((await probe.dom('button[aria-expanded="false"]')).elements).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/^Advanced\b/) })]));
    for (const label of ["All", "Apps", "Commands", "Agents", "Connections", "Show hidden", "Add", "Add workspace MCP"]) {
      await user.notSee({ role: "button", label: new RegExp(`^${label}$`) });
    }
    await user.notSee({ role: "tab", label: /^All\b/ });
    await user.notSee({ role: "textbox", label: "App name" });
    await user.notSee({ testId: "library-add-choices" });
    await user.notSee({ text: "Local MCP" });
    const libraryText = await probe.text();
    expect(libraryText).not.toContain("Voice Mode");
    expect(libraryText).not.toContain("Ollama");
    expect(libraryText).not.toMatch(/Google OAuth|Google Client ID|Google Client Secret/i);
    expect((await probe.dom('[aria-label*="voice mode" i]')).elements).toHaveLength(0);
    const add = await probe.dom('header button[aria-label="Add to library"]');
    expect(add.elements).toHaveLength(1);
    const addButton = add.elements[0];
    if (!addButton) throw new Error("Library has no header Add to library control.");
    expect(addButton.text).toBe("Add to library");
    expect(addButton.rect.left).toBeGreaterThanOrEqual(0);
    expect(addButton.rect.right).toBeLessThanOrEqual(820);
    expect(addButton.rect.top).toBeGreaterThanOrEqual(0);
    expect(addButton.rect.bottom).toBeLessThanOrEqual(760);
    expect(filters.documentWidth).toBeLessThanOrEqual(filters.viewportWidth);
    await user.screenshot();
  });

  await step("after: Add to library asks what to add, and one click on the MCP row sends an admin to this Den's MCP connections", async () => {
    const libraryHash = await probe.hash();
    const expectedUrl = new URL("/dashboard/mcp-connections", denWebUrl).toString();
    const openedBefore = await probe.eventually(() => world.browserUrls.opened(), {
      within: 10_000, label: "external-open requests before admin Add MCP",
    });
    await user.click({ role: "button", label: "Add to library" });
    await user.see({ testId: "library-add-choices" });
    const rowTitles = (await probe.dom('[data-testid="library-add-choices"] [data-kind-title]')).elements.map((element) => element.text);
    expect(rowTitles).toEqual(["Organization MCP", "Skill", "Plugin"]);
    const pickerDialogs = (await probe.dom('[role="dialog"]')).elements.length;
    expect(pickerDialogs).toBe(1);
    await user.notSee({ role: "button", label: "Continue" });
    await user.screenshot();
    expect(await world.browserUrls.opened()).toEqual(openedBefore);
    await user.press("Escape");
    await user.notSee({ testId: "library-add-choices" });
    expect(await world.browserUrls.opened()).toEqual(openedBefore);
    await user.click({ role: "button", label: "Add to library" });
    await user.click({ text: "Organization MCP" });
    const openedAfter = await probe.eventually(() => world.browserUrls.opened(), {
      within: 10_000,
      label: "admin Add MCP issues a fresh external-open request",
      until: (urls) => urls.length > openedBefore.length,
    });
    expect(openedAfter).toHaveLength(openedBefore.length + 1);
    expect(openedAfter.slice(openedBefore.length)).toEqual([expectedUrl]);
    await user.notSee({ role: "textbox", label: "App name" });
    await user.notSee({ text: "Add workspace MCP" });
    await user.notSee({ testId: "library-add-choices" });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    expect(await probe.hash()).toBe(libraryHash);
    expect(await probe.storage("openwork.den.activeOrgId")).toBe(orgId);
    await user.see({ role: "button", label: "Add to library" });
    expect((await probe.dom('header button[aria-label="Add to library"]:not(:disabled):not([aria-disabled="true"])')).elements).toHaveLength(1);
    evidence.recordAssertionEvidence(
      "Admin Cloud MCP Add requests the exact fixture Den MCP connections URL without local creation UI",
      `picker rows=${rowTitles.join(" / ")} in ${pickerDialogs} dialog with no Continue button; one click on Organization MCP: external-open count=${openedBefore.length}->${openedAfter.length}; captured URL=${openedAfter.at(-1)}; expected=${expectedUrl}; Library route and organization retained with zero dialogs. Bootstrap context=${JSON.stringify(bootstrap)}. The fixture captures the final desktop boundary without launching an OS browser.`,
      openedAfter.length === openedBefore.length + 1 && openedAfter.at(-1) === expectedUrl,
    );
  });

  for (const { filter, addLabel, emptyTitle, hint, formTitle } of [
    { filter: "Skills", addLabel: "Create skill", emptyTitle: "No skills yet", hint: "Add reusable instructions for work your agents do often.", formTitle: "Create a skill" },
    { filter: "Plugins", addLabel: "Add plugin", emptyTitle: "No plugins yet", hint: "Add a plugin to bring related skills and MCPs into your Library.", formTitle: "Create a plugin" },
  ]) {
    await step(`${filter} has its own empty state, and both Add actions open ${formTitle} as a full page`, async () => {
      await user.click({ role: "button", label: filter });
      await user.see({ text: emptyTitle });
      await user.see({ text: hint });
      expect((await probe.dom('[aria-label="Library filters"] button[aria-pressed="true"]:not([aria-label])')).elements.map((element) => element.text)).toEqual([filter]);
      expect((await probe.dom('header button[aria-label="Add to library"]')).elements).toMatchObject([{ text: "Add to library" }]);
      expect((await probe.dom('header button[aria-label="Add to library"]:not(:disabled):not([aria-disabled="true"])')).elements).toHaveLength(1);
      await user.see({ role: "button", label: addLabel }, { text: addLabel });
      await user.notSee({ role: "button", label: "Add MCP" });
      await user.notSee({ role: "button", label: "Add workspace MCP" });
      await user.type({ placeholder: "Search your library" }, "library-discovery-no-match", { replace: true });
      await user.see({ text: "No library items match these filters." });
      await user.notSee({ text: emptyTitle });
      await user.click({ role: "button", label: "Clear filters" });
      await user.see({ placeholder: "Search your library" }, { value: "" });
      await user.see({ text: emptyTitle });
      const pageOpens: string[] = [];
      for (const entryPoint of ["header", "empty-state"]) {
        if (entryPoint === "header") {
          await user.click({ role: "button", label: "Add to library" });
          await user.see({ testId: "library-add-choices" });
          await user.click({ text: filter === "Skills" ? /^Skill$/ : /^Plugin$/ });
        } else {
          await user.click({ role: "button", label: addLabel });
        }
        await user.see({ testId: "library-create-page" });
        await user.notSee({ role: "textbox", label: "App name" });
        await user.notSee({ testId: "library-add-choices" });
        await user.notSee({ placeholder: "Search your library" });
        await user.see({ role: "heading", label: formTitle });
        const formDialogs = (await probe.dom('[role="dialog"]')).elements.length;
        expect(formDialogs).toBe(0);
        pageOpens.push(`${entryPoint}: "${formTitle}" page, dialogs=${formDialogs}`);
        if (entryPoint === "header") await user.screenshot();
        await user.press("Escape");
        await user.notSee({ testId: "library-create-page" });
        await user.see({ text: emptyTitle });
      }
      evidence.recordAssertionEvidence(
        `${formTitle} is a full page from both Add actions, and Escape returns to the Library`,
        `${pageOpens.join("; ")}; the Library list and search are replaced while the page is open; Escape → "${emptyTitle}" again`,
        pageOpens.length === 2,
      );
    });
  }

  await step("after: a plugin's MCP server asks how it signs in, and whose account only once it is shared with everyone", async () => {
    await user.click({ role: "button", label: "Add plugin" });
    await user.see({ testId: "library-create-page" });
    await user.click({ role: "button", label: "MCP server" });
    await user.see({ text: "How does it sign in?" });
    const labels = (await probe.dom('[role="radiogroup"][aria-label="How does it sign in?"] [role="radio"] span > span:first-child')).elements.map((element) => element.text);
    expect(labels).toEqual(["With an account", "With a key", "No sign-in"]);
    await user.notSee({ text: "Whose account does the AI use?" });
    await user.see({ text: "Only you can use it until you share it." });
    await user.screenshot();
    await user.click({ text: "Share with everyone in the organization" });
    await user.see({ text: "Whose account does the AI use?" });
    await user.notSee({ text: "Only you can use it until you share it." });
    evidence.recordAssertionEvidence(
      "Whose account the AI uses is only asked once other people can use it",
      `sign-in options=${labels.join(" / ")}; just me → no "Whose account does the AI use?" and the footer says "Only you can use it until you share it."; after "Share with everyone in the organization" → the question appears and the footer note is gone`,
      labels.length === 3,
    );
    await user.press("Escape");
    await user.notSee({ testId: "library-create-page" });
  });

  await step("only Advanced exposes the workspace MCP form and closing it restores Cloud-only inventory", async () => {
    await user.click({ role: "button", label: "MCPs" });
    await user.notSee({ role: "button", label: "Add workspace MCP" });
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.click({ role: "button", label: "Add workspace MCP" });
    await user.see({ role: "textbox", label: "App name" });
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(1);
    await user.press("Escape");
    await user.notSee({ role: "textbox", label: "App name" });
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.notSee({ role: "button", label: "Add workspace MCP" });
    await user.notSee({ text: "Local MCP" });
    await user.see({ role: "button", label: "Add to library" });
    expect((await probe.dom('header button[aria-label="Add to library"]:not(:disabled):not([aria-disabled="true"])')).elements).toHaveLength(1);
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    await user.screenshot();
  });
});
