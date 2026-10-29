import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminOpportunitiesWorld } from "../worlds/admin-opportunities.ts";

const test = spec.world(adminOpportunitiesWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("a platform admin finds recent workplace adoption and opens the people behind it", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin);

  await step("before: the organization list has no workplace adoption signals", async () => {
    await admin.see({ role: "heading", label: "Organizations" }, { timeoutMs: 60_000 });
    await admin.see({ role: "link", label: "Opportunities" });
    await admin.notSee({ text: "Company-email signal" });
    const hasAdoptionColumns = await probe.on(world.admin).has("Company-email signal");
    expect(hasAdoptionColumns).toBe(false);
    evidence.recordAssertionEvidence("The ordinary organization directory remains unchanged", "The admin is on Organizations; adoption signals have their own Opportunities destination.", !hasAdoptionColumns);
    await admin.screenshot();
  });

  await step("after: Opportunities opens a weekly control center with drilldowns", async () => {
    await admin.click({ role: "link", label: "Opportunities" });
    await admin.see({ role: "heading", label: "Opportunities" });
    await admin.see({ role: "heading", label: "Work queue" });
    await admin.see({ role: "heading", label: "Recent signups" });
    await admin.see({ role: "heading", label: "Teams adding people" });
    await admin.see({ role: "heading", label: "Activity to check" });
    await admin.screenshot();
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const layout = await probe.on(world.admin).dom('[data-testid="admin-opportunity-overview"]');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    await admin.screenshot();
    await admin.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await admin.click({ role: "link", label: "Adoption opportunities" });
    await admin.see({ role: "heading", label: "Adoption opportunities" });
    await admin.see({ text: "2 matching organizations · page 1" });
    await admin.see({ role: "link", label: "Workplace example" });
    await admin.see({ role: "link", label: "Personal workspace" });
    await admin.notSee({ role: "link", label: "Solo workplace" });
    await admin.notSee({ role: "link", label: "No observed usage" });
    const names = await probe.on(world.admin).dom('[data-testid^="admin-opportunity-"]');
    const firstIsWorkplace = names.elements[0]?.text.includes("Workplace example") ?? false;
    expect(firstIsWorkplace).toBe(true);
    evidence.recordAssertionEvidence("Recent multi-user adoption leads the list", "Two organizations qualify; the recent workplace appears before the older personal workspace. Solo and unobserved organizations are absent.", firstIsWorkplace);
    await admin.screenshot();
  });

  await step("the admin narrows to company-email signals with skills and MCPs", async () => {
    await admin.click({ role: "button", label: "Email signal" });
    await admin.click({ role: "option", label: "Company-email signal" });
    await admin.click({ role: "button", label: "Cloud setup" });
    await admin.click({ role: "option", label: "Has skills and MCPs" });
    await admin.see({ text: "1 matching organizations · page 1" });
    await admin.see({ text: "studio.example.test" });
    await admin.see({ text: "1 skill" });
    await admin.see({ text: "1 MCP" });
    await admin.notSee({ role: "link", label: "Personal workspace" });
    await admin.reload();
    await admin.see({ text: "1 matching organizations · page 1" });
    const filtered = await probe.on(world.admin).dom('[data-testid^="admin-opportunity-"]');
    const onlyWorkplace = filtered.elements.length === 1 && filtered.elements[0]?.text.includes("Workplace example");
    expect(onlyWorkplace).toBe(true);
    evidence.recordAssertionEvidence("Email and Cloud setup filters survive a reload", "Only the workplace with verified non-personal addresses, one Cloud skill and one MCP entry remains.", onlyWorkplace);
    await admin.screenshot();
  });

  await step("the same filters and organization remain usable on a narrow screen", async () => {
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await admin.see({ role: "link", label: "Workplace example" });
    const layout = await probe.on(world.admin).dom('[aria-label="Opportunity filters"]');
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("The page reflows within the narrow viewport", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px; the table has its own horizontal scroll area.`, layout.documentWidth <= layout.viewportWidth);
    await admin.screenshot();
    await admin.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  });

  await step("the admin can identify an individual opportunity and inspect its members", async () => {
    await admin.click({ role: "button", label: "Joined users" });
    await admin.click({ role: "option", label: "1 or more" });
    await admin.click({ role: "button", label: "Cloud setup" });
    await admin.click({ role: "option", label: "Any setup" });
    await admin.see({ role: "link", label: "Solo workplace" });
    await admin.click({ role: "link", label: "Workplace example" });
    await admin.see({ role: "heading", label: "Workplace example" });
    await admin.see({ role: "heading", label: "Members" });
    await admin.see({ role: "link", label: "Workspace Teammate" });
    const people = await probe.on(world.admin).dom('[data-testid^="admin-organization-member-"]');
    const teammateVisible = people.elements.some(person => person.text.includes("Workspace Teammate"));
    expect(teammateVisible).toBe(true);
    evidence.recordAssertionEvidence("Organization signals lead to actual people", "The solo-user filter reveals individual adoption, and opening a workplace reaches its real member directory.", teammateVisible);
    await admin.screenshot();
  });

  await step("an ordinary member and a signed-out visitor cannot read opportunities", async () => {
    const member = user.on(world.member);
    const anonymous = user.on(world.anonymous);
    await member.see({ role: "heading", label: "Admin access required" });
    await anonymous.see({ role: "heading", label: "Sign in required" });
    await member.notSee({ role: "link", label: "Workplace example" });
    await anonymous.notSee({ role: "link", label: "Workplace example" });
    const denied = await probe.api(world.den.members.peer, "/v1/admin/opportunities");
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("Organization ownership and membership do not grant platform reporting access", "The member receives 403 from the report; member and signed-out pages show access states without organization records.", denied.response.status === 403);
    await member.screenshot();
  });
});
