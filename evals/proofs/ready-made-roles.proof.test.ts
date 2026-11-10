import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { readyMadeRolesWorld } from "../worlds/ready-made-roles.ts";

/** Matches text anywhere inside the target (an exact string must match the whole element). */
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const test = spec.world(readyMadeRolesWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner creates the ready-made Billing manager role and gives it to a team from the same role list every screen shows", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner);
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const roles = world.url("/dashboard/members?tab=roles");
  const finance = world.url(`/dashboard/members/teams/${world.financeId}`);

  await step("before: Roles lists the built-in roles and has no ready-made Billing manager", async () => {
    await owner.see({ testId: "role-row-owner" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "role-row-admin" }, { text: has("Invite people, manage teams, and run connections and models") });
    await owner.notSee({ testId: "roles-ready-made" });
    const custom = await world.customRoles();
    evidence.recordAssertionEvidence("No ready-made roles and no custom roles yet", `custom roles=${JSON.stringify(custom)}`, custom.length === 0);
    expect(custom).toEqual([]);
    await owner.screenshot();
  });

  await step("before: Finance's Change role lists Member and Admin, and leaves Super admin and Owner out without saying why", async () => {
    await owner.navigate(finance);
    await owner.see({ testId: "team-role-change" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "team-role-change" });
    await owner.see({ testId: "team-role-option-admin" }, { text: has("Invite people, manage teams, and run connections and models") });
    await owner.notSee({ testId: "team-role-option-super-admin" });
    await owner.notSee({ testId: "team-role-option-owner" });
    await owner.screenshot();
    await owner.press("Escape");
  });

  await step("after: with Ready-made roles on, Roles offers Billing manager with what it is for", async () => {
    await world.turnOnReadyMadeRoles();
    await owner.navigate(roles);
    await owner.see({ testId: "role-row-ready-made-billing" }, { text: has("See plan, usage and invoices, and manage payment details"), timeoutMs: 90_000 });
    await owner.see({ testId: "role-ready-made-create-billing" });
    await owner.screenshot();
  });

  await step("an admin who can't manage permissions sees Billing manager with Create role locked", async () => {
    await admin.navigate(roles);
    await admin.see({ testId: "role-row-ready-made-billing" }, { timeoutMs: 90_000 });
    await admin.notSee({ testId: "role-ready-made-create-billing" });
    const locked = await adminProbe.dom('[data-testid="role-row-ready-made-billing"] button[disabled]');
    const ok = locked.elements.length === 1;
    evidence.recordAssertionEvidence("The admin's Create role is a locked button, not a link", `locked buttons=${locked.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: its Create role opens the form named Billing manager with its five permissions already on", async () => {
    await owner.click({ testId: "role-ready-made-create-billing" });
    await owner.see({ testId: "role-new-start-billing" }, { timeoutMs: 90_000 });
    await owner.notSee({ testId: "role-new-start-missing" });
    await owner.screenshot();
    await owner.see({ testId: "role-new-save-bar" }, { text: has("5 permissions selected") });
  });

  await step("after: the owner creates it, and Roles lists Billing manager as a custom role instead of offering it", async () => {
    await owner.click({ testId: "role-new-create" });
    await owner.see({ testId: "permission-set" }, { text: has("Billing manager"), timeoutMs: 60_000 });
    await owner.navigate(roles);
    await owner.see({ testId: "role-row-custom" }, { text: has("Billing manager"), timeoutMs: 90_000 });
    await owner.notSee({ testId: "roles-ready-made" });
    const custom = await world.customRoles();
    const ok = custom.length === 1 && custom[0]?.name === "Billing manager" && custom[0]?.allowedCount === 5;
    evidence.recordAssertionEvidence("One custom role, Billing manager, with five permissions", JSON.stringify(custom.map(({ name, allowedCount }) => ({ name, allowedCount }))), ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("after: inviting someone lists the same roles, with Owner locked and why", async () => {
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "button", label: "Add member" }, { timeoutMs: 90_000 });
    await owner.click({ role: "button", label: "Add member" });
    await owner.click({ testId: "member-role-change" });
    await owner.see({ testId: "member-role-option-owner" }, { text: has("Changes by transferring ownership.") });
    await owner.see({ testId: "member-role-option-super-admin" }, { text: has("Everything the owner can do, except delete the organization") });
    const [billing] = await world.customRoles();
    await owner.see({ testId: `member-role-option-role:${billing?.id}` }, { text: has("Billing manager") });
    await owner.screenshot();
    await owner.press("Escape");
  });

  await step("after: Finance's Change role lists every role, with Super admin and Owner locked and why", async () => {
    await owner.navigate(finance);
    await owner.see({ testId: "team-role-change" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "team-role-change" });
    await owner.see({ testId: "team-role-option-super-admin" }, { text: has("Given to people, not teams.") });
    await owner.see({ testId: "team-role-option-owner" }, { text: has("Held by one person, not a team.") });
    const [billing] = await world.customRoles();
    await owner.see({ testId: `team-role-option-role:${billing?.id}` }, { text: has("Billing manager") });
    await owner.screenshot();
  });

  await step("after: the owner gives Finance the Billing manager role, and Riley can see invoices but still can't manage members", async () => {
    const [billing] = await world.customRoles();
    await owner.click({ testId: `team-role-option-role:${billing?.id}` });
    await owner.click({ testId: "team-role-save" });
    await owner.see({ testId: "team-role-name" }, { text: has("Billing manager"), timeoutMs: 30_000 });
    const held = await world.rileyPermissions();
    const ok = held.includes("billing_invoices.view") && held.includes("billing_portal.use") && !held.includes("members.update") && !held.includes("permissions.manage");
    evidence.recordAssertionEvidence("Riley holds the billing permissions and nothing about members or permissions", `held=${held.join(", ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });
});
