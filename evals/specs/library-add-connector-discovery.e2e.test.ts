import { expect } from "vitest";
import { needs, spec, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { libraryConnectorDiscovery } from "../worlds/library.ts";

const test = spec.world(libraryConnectorDiscovery);

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library connector discovery skipped — needs: ${missingRequirements.join(", ")}`
  : "Library starts with Cloud MCPs and keeps local MCP creation in Advanced";

test(title, async ({ evidence, world, user, probe, step }) => {
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

  await step("Library defaults to MCPs, Ready to use, and cards with only three type filters", async () => {
    // Open the main Library route, independent of responsive Settings navigation.
    const currentUrl = await probe.eval(() => location.href);
    await user.navigate(new URL(`#/workspace/${workspaceId}/extensions`, currentUrl).href);
    await user.see({ role: "button", label: "Add MCP", nth: 0 }, { timeoutMs: 90_000 });
    await probe.eventually(() => probe.dom('header button[aria-label="Add MCP"]:not(:disabled):not([aria-disabled="true"])'), {
      within: 90_000,
      label: "the signed-in admin's header Add MCP is enabled",
      until: (snapshot) => snapshot.elements.length === 1,
    });
    expect(await probe.hash()).toBe(`#/workspace/${workspaceId}/extensions`);
    const filters = await probe.dom('[aria-label="Library filters"] button[aria-pressed]:not([aria-label])');
    expect(filters.elements.map((element) => element.text)).toEqual(["MCPs", "Skills", "Plugins"]);
    expect((await probe.dom('[aria-label="Library filters"] button[aria-pressed="true"]:not([aria-label])')).elements.map((element) => element.text)).toEqual(["MCPs"]);
    expect((await probe.dom('[role="tab"][aria-selected="true"]')).elements).toMatchObject([{ text: expect.stringMatching(/^Ready to use\b/) }]);
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
    expect(libraryText).not.toMatch(/Google OAuth|Google Client ID|Google Client Secret/i);
    expect((await probe.dom('[aria-label*="voice mode" i]')).elements).toHaveLength(0);
    const add = await probe.dom('header button[aria-label="Add MCP"]');
    expect(add.elements).toHaveLength(1);
    const addButton = add.elements[0];
    if (!addButton) throw new Error("Library has no header Add MCP control.");
    expect(addButton.text).toBe("");
    expect(addButton.rect.left).toBeGreaterThanOrEqual(0);
    expect(addButton.rect.right).toBeLessThanOrEqual(820);
    expect(addButton.rect.top).toBeGreaterThanOrEqual(0);
    expect(addButton.rect.bottom).toBeLessThanOrEqual(760);
    expect(filters.documentWidth).toBeLessThanOrEqual(filters.viewportWidth);
    await user.screenshot();
  });

  await step("admin MCP Add requests this Den's MCP connections without local creation UI", async () => {
    const libraryHash = await probe.hash();
    const expectedUrl = new URL("/dashboard/mcp-connections", denWebUrl).toString();
    const openedBefore = await probe.eventually(() => world.browserUrls.opened(), {
      within: 10_000, label: "external-open requests before admin Add MCP",
    });
    await user.click({ role: "button", label: "Add MCP", nth: 0 });
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
    await user.see({ role: "button", label: "Add MCP", nth: 0 });
    expect((await probe.dom('header button[aria-label="Add MCP"]:not(:disabled):not([aria-disabled="true"])')).elements).toHaveLength(1);
    evidence.recordAssertionEvidence(
      "Admin Cloud MCP Add requests the exact fixture Den MCP connections URL without local creation UI",
      `Bootstrap context=${JSON.stringify(bootstrap)}; external-open count=${openedBefore.length}->${openedAfter.length}; captured URL=${openedAfter.at(-1)}; expected=${expectedUrl}; Library route and organization retained with zero dialogs. The fixture captures the final desktop boundary without launching an OS browser.`,
      openedAfter.length === openedBefore.length + 1 && openedAfter.at(-1) === expectedUrl,
    );
  });

  for (const { filter, addLabel, emptyTitle, hint, formTitle } of [
    { filter: "Skills", addLabel: "Create skill", emptyTitle: "No skills yet", hint: "Add reusable instructions for work your agents do often.", formTitle: "Create a skill" },
    { filter: "Plugins", addLabel: "Add plugin", emptyTitle: "No plugins yet", hint: "Add a plugin to bring related skills and MCPs into your Library.", formTitle: "Create a plugin" },
  ]) {
    await step(`${filter} has its own empty state, search recovery, and separate header and empty-state actions`, async () => {
      await user.click({ role: "button", label: filter });
      await user.see({ text: emptyTitle });
      await user.see({ text: hint });
      expect((await probe.dom('[aria-label="Library filters"] button[aria-pressed="true"]:not([aria-label])')).elements.map((element) => element.text)).toEqual([filter]);
      expect((await probe.dom(`header button[aria-label="${addLabel}"]`)).elements).toMatchObject([{ text: "" }]);
      expect((await probe.dom(`header button[aria-label="${addLabel}"]:not(:disabled):not([aria-disabled="true"])`)).elements).toHaveLength(1);
      await user.see({ role: "button", label: addLabel, nth: 1 }, { text: addLabel });
      await user.notSee({ role: "button", label: "Add MCP" });
      await user.notSee({ role: "button", label: "Add workspace MCP" });
      await user.type({ placeholder: "Search your library" }, "library-discovery-no-match", { replace: true });
      await user.see({ text: "No library items match these filters." });
      await user.notSee({ text: emptyTitle });
      await user.click({ role: "button", label: "Clear filters" });
      await user.see({ placeholder: "Search your library" }, { value: "" });
      await user.see({ text: emptyTitle });
      // The icon-only header precedes the labeled empty-state CTA in DOM order.
      for (const nth of [0, 1]) {
        await user.see({ role: "button", label: addLabel, nth }, { text: nth === 0 ? "" : addLabel });
        await user.click({ role: "button", label: addLabel, nth });
        await user.see({ text: formTitle });
        await user.notSee({ role: "textbox", label: "App name" });
        await user.notSee({ testId: "library-add-choices" });
        expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(1);
        await user.press("Escape");
        await user.notSee({ text: formTitle });
        await user.see({ text: emptyTitle });
      }
    });
  }

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
    await user.see({ role: "button", label: "Add MCP", nth: 0 });
    expect((await probe.dom('header button[aria-label="Add MCP"]:not(:disabled):not([aria-disabled="true"])')).elements).toHaveLength(1);
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    await user.screenshot();
  });
});
