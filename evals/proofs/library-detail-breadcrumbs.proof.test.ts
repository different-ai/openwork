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

  await step("before: a skill has only a back button to Library", async () => {
    await user.navigate(`${library}/skills`);
    await user.click({ text: /^review-notes$/ });
    await user.see({ role: "heading", label: "review-notes" });
    await user.see({ role: "button", label: /^Library$/ });
    const count = (await probe.dom(crumbs)).elements.length;
    evidence.recordAssertionEvidence("The old detail has no breadcrumb trail", `breadcrumb navigation count=${count}`, count === 0);
    expect(count).toBe(0);
    await user.screenshot();
  });

  await step("after: a skill shows Library, Skills and its current name", async () => {
    await world.setBreadcrumbs(true);
    await user.reload();
    await user.see({ role: "button", label: /^Skills$/ }, { timeoutMs: 60_000 });
    expect((await probe.dom(`${crumbs} [aria-current="page"]`)).elements[0]?.text).toBe("review-notes");
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

  await step("turning the rollout off restores the original back button without losing the open page", async () => {
    await world.setBreadcrumbs(false);
    await user.reload();
    await user.see({ role: "heading", label: "Review toolkit" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: /^Library$/ });
    const count = (await probe.dom(crumbs)).elements.length;
    evidence.recordAssertionEvidence("The open plugin remains available after rollback", `breadcrumb navigation count=${count}`, count === 0);
    expect(count).toBe(0);
    await user.screenshot();
  });
});
