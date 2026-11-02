import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryDetailBreadcrumbs } from "../worlds/library-detail-breadcrumbs.ts";

const test = spec.world(libraryDetailBreadcrumbs, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

test("a member follows a skill's breadcrumbs back to its category or parent plugin", async ({ world, user, probe, step, evidence }) => {
  const library = `${world.app.webUrl}/workspace/${world.workspace.workspaceId}/extensions`;
  const crumbs = '[data-extension-detail-page] nav';

  await step("by default a skill shows Library, Skills and its current name", async () => {
    await user.navigate(`${library}/skills`);
    await user.click({ text: /^review-notes$/ });
    // The category button also exists on the list we are leaving. Wait for the
    // detail's actual current-page breadcrumb, not that background list control.
    const current = await probe.eventually(async () => (await probe.dom(`${crumbs} [aria-current="page"]`)).elements.map(element => element.text), {
      within: 60_000, label: "the skill detail marks review-notes as its current breadcrumb", until: value => value.length === 1 && value[0] === "review-notes",
    });
    expect(current).toEqual(["review-notes"]);
    await user.see({ role: "button", label: /^Skills$/ });
    const trail = (await probe.dom(crumbs)).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("The skill's category and current page are visible", trail, trail.includes("Library") && trail.includes("Skills") && trail.includes("review-notes"));
    expect(trail).toContain("Skills");
    await user.screenshot();
  });

  await step("the Skills breadcrumb returns to Skills rather than resetting to All", async () => {
    await user.click({ role: "button", label: /^Skills$/ });
    const selected = await probe.eventually(async () => (await probe.dom('button[aria-pressed="true"]')).elements[0]?.text, {
      within: 15_000, label: "the Skills list replaces the detail page", until: value => value === "Skills",
    });
    expect(selected).toBe("Skills");
    const path = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("Skills remains the selected Library category", path, path.endsWith("/extensions/skills"));
    expect(path).toMatch(/\/extensions\/skills$/);
    await user.screenshot();
    await user.click({ text: /^review-notes$/ });
    await user.see({ role: "heading", label: "review-notes" });
    await user.click({ role: "button", label: /^Close$/ });
    const returned = await probe.eventually(() => probe.url(), {
      within: 15_000, label: "Close returns to the selected category", until: value => new URL(value).pathname.endsWith("/extensions/skills"),
    });
    expect(new URL(returned).pathname).toMatch(/\/extensions\/skills$/);
    const selectedAfterClose = await probe.eventually(async () => (await probe.dom('button[aria-pressed="true"]')).elements[0]?.text, {
      within: 15_000, label: "Close restores the Skills list", until: value => value === "Skills",
    });
    expect(selectedAfterClose).toBe("Skills");
  });

  await step("a plugin's skill keeps its parent in the breadcrumb trail", async () => {
    await user.navigate(`${library}/${encodeURIComponent(`plugin:${world.pluginId}`)}`);
    await user.see({ role: "heading", label: "Review toolkit" }, { timeoutMs: 60_000 });
    await user.click({ text: /^plan-a-review$/ });
    const current = await probe.eventually(async () => (await probe.dom(`${crumbs} [aria-current="page"]`)).elements.map(element => element.text), {
      within: 30_000, label: "the nested skill becomes the current breadcrumb", until: value => value.length === 1 && value[0] === "plan-a-review",
    });
    expect(current).toEqual(["plan-a-review"]);
    await user.see({ role: "button", label: /^Review toolkit$/ });
    const trail = (await probe.dom(crumbs)).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("Opening the nested skill keeps its actual parent", trail, trail.includes("Review toolkit") && trail.includes("plan-a-review"));
    expect(trail).toContain("plan-a-review");
    await user.screenshot();
    await user.click({ role: "button", label: /^Review toolkit$/ });
    await user.see({ role: "heading", label: "Review toolkit" });
    const path = decodeURIComponent(new URL(await probe.url()).pathname);
    evidence.recordAssertionEvidence("The parent breadcrumb returns to that plugin, not Library", path, path.endsWith(`/extensions/plugin:${world.pluginId}`));
    expect(path).toContain(`plugin:${world.pluginId}`);
  });

});
