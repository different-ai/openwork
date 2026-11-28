import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationSidebarWorld } from "../worlds/organization-sidebar.ts";

const test = spec.world(organizationSidebarWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const WITHIN = 60_000;

test("an owner reaches Members, Teams and Roles from the sidebar's Organization section", async ({ world, user, probe, step, evidence }) => {
  const avery = user.on(world.owner);
  const averyPage = probe.on(world.owner);
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const read = async (page: typeof averyPage) => ({
    path: new URL((await page.url()).replace(/^#/, ""), "http://den.local").pathname,
    title: (await page.dom("main h1")).elements.map((element) => clean(element.text)).join(", "),
    selected: (await page.dom('[data-sidebar-section] a[aria-current="page"]')).elements.map((element) => clean(element.text)).join(", "),
    tabs: (await page.dom('main [role="tab"]')).elements.length,
  });
  const describe = (state: Awaited<ReturnType<typeof read>>) => `address ${state.path}; title ${state.title || "none"}; sidebar selection ${state.selected || "none"}; tabs on the page ${state.tabs}`;

  await step("an old link to the Teams tab opens the Teams page", async () => {
    await avery.see({ text: "Finance" }, { timeoutMs: 90_000 });
    const state = await probe.eventually(() => read(averyPage), { within: WITHIN, until: (value) => value.path === "/dashboard/members/teams" });
    await avery.screenshot();
    const ok = state.title === "Teams" && state.selected === "Teams" && state.tabs === 0;
    evidence.recordAssertionEvidence("A link to /dashboard/members?tab=teams lands on Teams, with no tabs", describe(state), ok);
    expect(ok).toBe(true);
  });

  await step("the sidebar's Organization section lists Members, Teams, Roles and Settings", async () => {
    const entries = (await averyPage.dom('[data-sidebar-section="organization"] > div > div > a, [data-sidebar-section="organization"] > div > div > button')).elements.map((element) => clean(element.text));
    const sections = (await averyPage.dom("[data-sidebar-section]")).elements.length;
    const old = (await averyPage.dom('[data-sidebar-section="team"]')).elements.length;
    const ok = ["Members", "Teams", "Roles", "Settings"].every((label, index) => entries[index]?.startsWith(label)) && old === 0;
    evidence.recordAssertionEvidence("Organization replaces the Team section and holds the four entries in order", `entries: ${entries.join(", ") || "none"}; sidebar sections: ${sections}; sections still called Team: ${old}`, ok);
    expect(ok).toBe(true);
  });

  await step("after: Members is its own page listing the people", async () => {
    await avery.click({ role: "link", label: "Members" });
    await avery.see({ text: "Riley Finance" }, { timeoutMs: WITHIN });
    const state = await probe.eventually(() => read(averyPage), { within: WITHIN, until: (value) => value.path === "/dashboard/members" && value.selected === "Members" });
    await avery.screenshot();
    const ok = state.title === "Members" && state.tabs === 0;
    evidence.recordAssertionEvidence("Members shows only people, and only Members is selected in the sidebar", describe(state), ok);
    expect(ok).toBe(true);
  });

  await step("after: Roles is its own page listing the built-in roles", async () => {
    await avery.click({ role: "link", label: "Roles" });
    await avery.see({ text: "Built-in roles" }, { timeoutMs: WITHIN });
    const state = await probe.eventually(() => read(averyPage), { within: WITHIN, until: (value) => value.path === "/dashboard/members/roles" && value.selected === "Roles" });
    await avery.screenshot();
    const ok = state.title === "Roles" && state.tabs === 0;
    evidence.recordAssertionEvidence("Roles has its own address and sidebar entry", describe(state), ok);
    expect(ok).toBe(true);
  });

  await step("a member without admin access still sees only Home", async () => {
    const riley = user.on(world.member);
    const rileyPage = probe.on(world.member);
    await riley.see({ testId: "member-home" }, { timeoutMs: 90_000 });
    const sections = (await rileyPage.dom("[data-sidebar-section]")).elements.map((element) => clean(element.text));
    await riley.screenshot();
    const ok = sections.length === 1 && sections[0].includes("Home") && !sections.join(" ").includes("Members");
    evidence.recordAssertionEvidence("Riley's sidebar has no Organization section", `sidebar sections: ${sections.join(" | ") || "none"}`, ok);
    expect(ok).toBe(true);
  });
});
