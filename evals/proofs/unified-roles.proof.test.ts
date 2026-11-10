import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { unifiedRolesWorld } from "../worlds/unified-roles.ts";

/** Matches text anywhere inside the target (an exact string must match the whole element). */
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const test = spec.world(unifiedRolesWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner gives the built-in Billing manager role to a person and to a team the same way, from every screen", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner);
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const roles = world.url("/dashboard/members?tab=roles");
  const people = world.url("/dashboard/members");
  const billingOnly = (held: readonly string[]) => held.includes("billing_portal.use") && held.includes("billing_invoices.view") && !held.includes("members.update") && !held.includes("permissions.manage");

  await step("Roles lists Billing manager as a built-in role nobody holds yet, with no custom roles", async () => {
    await owner.see({ testId: "role-row-billing-manager" }, { text: has("See plan, usage and invoices, and manage payment details"), timeoutMs: 90_000 });
    await owner.see({ testId: "role-row-billing-manager" }, { text: has("Nobody yet") });
    await owner.see({ testId: "role-row-owner" });
    const billing = await world.billingManager();
    const custom = await world.customRoles();
    const ok = billing.allowedCount === 5 && billing.memberIds.length === 0 && billing.teams.length === 0 && custom.length === 0;
    evidence.recordAssertionEvidence("Billing manager exists with five permissions, nobody holds it, and there are no custom roles", JSON.stringify({ ...billing, id: undefined, custom }), ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("on the role's page, Add person gives it to Casey at once, and Casey can manage billing but not members", async () => {
    await owner.click({ testId: "role-row-billing-manager" });
    await owner.see({ testId: "role-who-has-it" }, { text: has("Nobody yet."), timeoutMs: 90_000 });
    await owner.click({ testId: "access-add-person" });
    await owner.see({ testId: `access-add-person-option-${world.caseyId}` }, { text: has("now Member") });
    await owner.click({ testId: `access-add-person-option-${world.caseyId}` });
    await owner.click({ testId: "access-add-person-confirm" });
    await owner.see({ testId: "role-holder-person" }, { text: has("Casey Accounts"), timeoutMs: 30_000 });
    await owner.see({ testId: "den-toast" }, { text: has("Casey Accounts is now Billing manager") });
    const casey = await world.casey();
    const ok = casey.role === "member" && billingOnly(casey.permissions);
    evidence.recordAssertionEvidence("Casey is still a Member and holds exactly the billing permissions", `role=${casey.role}; held=${casey.permissions.join(", ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("Add team gives it to Finance from the same block, and Riley gets it through the team", async () => {
    await owner.click({ testId: "access-add-team" });
    await owner.click({ testId: `access-add-team-option-${world.financeId}` });
    await owner.click({ testId: "access-add-team-confirm" });
    await owner.see({ testId: "role-holder-team" }, { text: has("Finance"), timeoutMs: 30_000 });
    const riley = await world.riley();
    const billing = await world.billingManager();
    const ok = billingOnly(riley.permissions) && billing.memberIds.includes(world.caseyId) && billing.teams.some((team) => team.id === world.financeId);
    evidence.recordAssertionEvidence("Finance holds Billing manager, so Riley does too", `teams=${billing.teams.map((team) => team.name).join(", ")}; riley=${riley.permissions.join(", ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("People shows each person's role on their row: Casey is Billing manager, Riley is a Member who also has it via Finance", async () => {
    await owner.navigate(people);
    await owner.see({ testId: `member-role-${world.caseyId}-change` }, { text: has("Billing manager"), timeoutMs: 90_000 });
    await owner.see({ testId: `member-role-${world.rileyId}-change` }, { text: has("Member") });
    await owner.see({ testId: "member-team-roles" }, { text: has("Also Billing manager via Finance") });
    await owner.screenshot();
  });

  await step("the role on Riley's row is the control: it lists every role, with Owner locked and why", async () => {
    await owner.click({ testId: `member-role-${world.rileyId}-change` });
    await owner.see({ testId: `member-role-${world.rileyId}-option-billing-manager` }, { text: has("See plan, usage and invoices, and manage payment details") });
    await owner.see({ testId: `member-role-${world.rileyId}-option-super-admin` }, { text: has("Everything the owner can do, except delete the organization") });
    await owner.see({ testId: `member-role-${world.rileyId}-option-owner` }, { text: has("Changes by transferring ownership.") });
    await owner.screenshot();
  });

  await step("picking Admin makes Riley an admin at once, and Undo takes it back", async () => {
    await owner.click({ testId: `member-role-${world.rileyId}-option-admin` });
    await owner.see({ testId: "den-toast" }, { text: has("Riley Finance is now Admin"), timeoutMs: 30_000 });
    const promoted = await probe.eventually(() => world.riley(), { within: 30_000, label: "Riley is an admin", until: (riley) => riley.role === "admin" });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Undo" });
    const restored = await probe.eventually(() => world.riley(), { within: 30_000, label: "Riley is a member again", until: (riley) => riley.role === "member" });
    await owner.see({ testId: `member-role-${world.rileyId}-change` }, { text: has("Member"), timeoutMs: 30_000 });
    const ok = promoted.role === "admin" && restored.role === "member" && billingOnly(restored.permissions);
    evidence.recordAssertionEvidence("Riley became an admin, then a Member again with Billing manager still coming from Finance", `after change=${promoted.role}; after Undo=${restored.role}`, ok);
    expect(ok).toBe(true);
  });

  await step("Add member is a dialog over the list, and the person can be invited straight into Billing manager", async () => {
    await owner.click({ role: "button", label: "Add member" });
    await owner.see({ testId: "invite-dialog" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "invite-email" }, "jordan@example.com", { replace: true });
    await owner.click({ testId: "invite-role-change" });
    await owner.click({ testId: "invite-role-option-billing-manager" });
    await owner.see({ testId: "invite-role-change" }, { text: has("Billing manager") });
    await owner.screenshot();
    await owner.click({ testId: "invite-send" });
    await owner.see({ text: "jordan@example.com" }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "invite-dialog" });
    const jordanId = await world.memberIdByEmail("jordan@example.com");
    const billing = await world.billingManager();
    const ok = jordanId !== null && billing.memberIds.includes(jordanId);
    evidence.recordAssertionEvidence("The invited person holds Billing manager before they join", `invited member=${jordanId ? "found" : "missing"}; people with the role=${billing.memberIds.length}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("Create team is a dialog too, and the new team gets its role from the same list", async () => {
    await owner.navigate(world.url("/dashboard/members?tab=teams"));
    await owner.see({ role: "button", label: "Create team" }, { timeoutMs: 90_000 });
    await owner.click({ role: "button", label: "Create team" });
    await owner.see({ testId: "team-dialog" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "team-form-name" }, "Accounts payable", { replace: true });
    await owner.click({ testId: "team-form-role-change" });
    await owner.see({ testId: "team-form-role-option-owner" }, { text: has("Held by one person, not a team.") });
    await owner.click({ testId: "team-form-role-option-billing-manager" });
    await owner.screenshot();
    await owner.click({ testId: "team-form-save" });
    await owner.see({ testId: "teams-list" }, { text: has("Accounts payable"), timeoutMs: 30_000 });
    await owner.notSee({ testId: "team-dialog" });
    const billing = await probe.eventually(() => world.billingManager(), { within: 30_000, label: "Accounts payable holds Billing manager", until: (role) => role.teams.some((team) => team.name === "Accounts payable") });
    const ok = billing.teams.map((team) => team.name).sort().join(", ") === "Accounts payable, Finance";
    evidence.recordAssertionEvidence("Billing manager is on Finance and on the new team", `teams=${billing.teams.map((team) => team.name).sort().join(", ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("Roles now says who holds Billing manager", async () => {
    await owner.navigate(roles);
    await owner.see({ testId: "role-row-billing-manager" }, { text: has("2 people, Finance, Accounts payable"), timeoutMs: 90_000 });
    await owner.screenshot();
  });

  await step("an admin, who can't change roles, sees who has the role with Add person and Add team locked and why", async () => {
    await admin.navigate(roles);
    await admin.see({ testId: "role-row-billing-manager" }, { timeoutMs: 90_000 });
    await admin.click({ testId: "role-row-billing-manager" });
    await admin.see({ testId: "role-holder-team" }, { text: has("Finance"), timeoutMs: 90_000 });
    await admin.see({ testId: "role-holders-locked" });
    const locked = await adminProbe.dom('[data-testid="role-holders-add"] button[disabled]');
    const ok = locked.elements.length === 2;
    evidence.recordAssertionEvidence("Both Add person and Add team are locked for the admin", `locked buttons=${locked.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("on People the admin reads each role as text, with nothing to change", async () => {
    await admin.navigate(people);
    await admin.see({ text: "Billing manager" }, { timeoutMs: 90_000 });
    await admin.see({ text: "Member, Billing manager via Finance" });
    const pickers = await adminProbe.dom('[data-testid^="member-role-"][data-testid$="-change"]');
    const ok = pickers.elements.length === 0;
    evidence.recordAssertionEvidence("No role on the admin's People list is a control", `role pickers=${pickers.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("Create role asks who gets it, and giving it to Casey replaces the role Casey had", async () => {
    await owner.navigate(world.url("/dashboard/members?tab=roles"));
    await owner.see({ testId: "roles-create" }, { timeoutMs: 90_000 });
    await owner.click({ testId: "roles-create" });
    await owner.type({ testId: "role-new-name" }, "Support lead", { replace: true });
    await owner.see({ testId: "role-new-holders" }, { text: has("Nobody yet. You can also give it later.") });
    await owner.click({ testId: "access-add-person" });
    await owner.see({ testId: `access-add-person-option-${world.caseyId}` }, { text: has("now Billing manager") });
    await owner.click({ testId: `access-add-person-option-${world.caseyId}` });
    await owner.click({ testId: "access-add-person-confirm" });
    await owner.see({ testId: "role-holder-person" }, { text: has("Casey Accounts") });
    await owner.screenshot();
    await owner.click({ testId: "role-new-create" });
    await owner.see({ testId: "role-who-has-it" }, { text: has("Casey Accounts"), timeoutMs: 60_000 });
    const billing = await world.billingManager();
    const custom = await world.customRoles();
    const casey = await world.casey();
    const ok = custom.join(", ") === "Support lead" && !billing.memberIds.includes(world.caseyId) && !casey.permissions.includes("billing_portal.use");
    evidence.recordAssertionEvidence("Casey holds Support lead instead of Billing manager", `custom roles=${custom.join(", ")}; Casey still Billing manager=${billing.memberIds.includes(world.caseyId)}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });
});
