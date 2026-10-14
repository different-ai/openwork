import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import { ENGINEERING_KEYS, teamRolesWorld, type TeamRolesWorld } from "../worlds/team-roles.ts";

// Den Web Team roles (teamRoles): every team has one role, Member, Admin or
// Custom, shown on the team page with one Change role action, and Members has
// a Roles tab where an owner creates a role. Each journey starts from the
// dashboard. Nothing new is stored: Admin is the existing Admin team flag and
// Custom is the team's one permission set.
const test = spec.world(teamRolesWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function permissionsOf(probe: { api: (session: DenSession, path: string, init?: RequestInit) => Promise<{ body: unknown }> }, world: TeamRolesWorld, session: DenSession): Promise<string[]> {
  const context = await probe.api(session, "/v1/org", { headers: world.scope });
  const current = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember : null;
  return Array.isArray(current?.permissions) ? current.permissions.filter((key): key is string => typeof key === "string") : [];
}

test("an owner gives the Sales team the Admin role from its team page, and only Sales members become admins", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);

  await step("before: Maya, in Sales, can't invite people; neither can Nora, in no team", async () => {
    const [maya, nora] = await Promise.all([permissionsOf(probe, world, world.maya), permissionsOf(probe, world, world.nora)]);
    const ok = !maya.includes("invitations.manage") && !nora.includes("invitations.manage");
    evidence.recordAssertionEvidence("Neither member holds Invite people", `Maya holds ${maya.length} permissions; Nora holds ${nora.length}`, ok);
    expect(ok).toBe(true);
  });

  await step("from the dashboard, the owner opens Members › Teams › Sales and sees its role is Member", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Teams/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.see({ role: "link", label: "Sales" }, { timeoutMs: 30_000 });
    await owner.notSee({ text: /Grant organisation Admin to all members of/ });
    await owner.click({ role: "link", label: "Sales" });
    await owner.see({ testId: "team-role-name" }, { text: "Member", timeoutMs: 60_000 });
    await owner.notSee({ text: /Grant organisation Admin to all members of/ });
    await owner.see({ text: "Nothing beyond what everyone can do" });
    await owner.see({ testId: "team-role-everyone" }, { text: /Use skills, plugins and connections shared with them/ });
    evidence.recordAssertionEvidence("The team page opens on its one role", "Role tab shows Member and what everyone can do", true);
    await owner.screenshot();
  });

  await step("the owner clicks Change role and picks Admin, right on the team page", async () => {
    await owner.click({ testId: "team-role-change" });
    await owner.see({ testId: "team-role-choice" }, { timeoutMs: 15_000 });
    await owner.click({ testId: "team-role-option-admin" });
    await owner.see({ role: "button", label: "Change to Admin" });
    expect((await probe.on(world.ownerWeb).dom('[role="dialog"], dialog[open]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Member, Admin and Custom open in place under the current role, no dialog", "Admin selected; the action names the change", true);
    await owner.screenshot();
  });

  await step("after: Sales is Admin, and the page lists what Sales can now do", async () => {
    await owner.click({ testId: "team-role-save" });
    await owner.see({ testId: "team-role-name" }, { text: "Admin", timeoutMs: 30_000 });
    await owner.see({ testId: "den-toast" }, { text: /Sales is now Admin/ });
    await owner.see({ testId: "team-role-also" }, { text: /Invite people/ });
    const team = await probe.api(world.owner, `/v1/teams/${encodeURIComponent(world.teams.sales)}`, { headers: world.scope });
    const flagged = isRecord(team.body) && isRecord(team.body.team) && team.body.team.grantsOrganizationAdmin === true;
    evidence.recordAssertionEvidence("Admin is the existing Admin team flag", `GET /v1/teams/:sales → grantsOrganizationAdmin ${String(flagged)}`, flagged);
    expect(flagged).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: Maya gains Invite people through Sales; Nora, outside it, does not", async () => {
    const [maya, nora] = await Promise.all([permissionsOf(probe, world, world.maya), permissionsOf(probe, world, world.nora)]);
    const ok = maya.includes("invitations.manage") && !nora.includes("invitations.manage");
    evidence.recordAssertionEvidence("Only Sales members gain the Admin permissions", `Maya holds Invite people: ${maya.includes("invitations.manage")}; Nora: ${nora.includes("invitations.manage")}`, ok);
    expect(ok).toBe(true);
  });
});

test("an owner creates a Skill publishers role from Members › Roles, and only the people in it can share with everyone", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);

  await step("from the dashboard, the owner opens Members › Roles and sees built-in and custom roles", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Roles/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Roles/ });
    await owner.see({ testId: "role-row-member" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "role-row-admin" });
    await owner.see({ testId: "role-row-owner" });
    await owner.see({ testId: "role-row-custom" }, { text: /Engineering/, timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("Roles lists Member, Admin, Owner and Engineering's custom role", "Built-in and custom sections render", true);
    await owner.screenshot();
  });

  await step("the owner names the role, adds Nora, and turns on Share with everyone", async () => {
    await owner.click({ testId: "roles-create" });
    await owner.see({ testId: "role-new-name" }, { timeoutMs: 30_000 });
    await owner.type({ testId: "role-new-name" }, "Skill publishers");
    await owner.click({ role: "button", label: "Add person" });
    await owner.see({ testId: "access-add-person-popover" }, { timeoutMs: 15_000 });
    await owner.click({ role: "option", label: /Nora Newcomer/ });
    await owner.click({ role: "button", label: "Add Nora Newcomer" });
    await owner.see({ testId: "role-new-person" }, { text: /Nora Newcomer/ });
    await owner.click({ role: "switch", label: /^Share with everyone$/ });
    evidence.recordAssertionEvidence("The form takes a name, people and permissions", "Nora added; Share with everyone on", true);
    await owner.screenshot();
  });

  await step("after: the role is created and opens as its team page with role Custom", async () => {
    await owner.click({ testId: "role-new-create" });
    await owner.see({ testId: "team-role-name" }, { text: "Custom", timeoutMs: 60_000 });
    await owner.see({ testId: "team-role-also" }, { text: /Share with everyone/ });
    evidence.recordAssertionEvidence("Create role made a team and its permission set", "Team page shows Custom with Share with everyone", true);
    await owner.screenshot();
  });

  await step("boundary: Nora can now share with everyone; Maya, outside the role, cannot", async () => {
    const [nora, maya] = await Promise.all([permissionsOf(probe, world, world.nora), permissionsOf(probe, world, world.maya)]);
    const ok = nora.includes("sharing.share_org_wide") && !maya.includes("sharing.share_org_wide");
    evidence.recordAssertionEvidence("Only people in the new role gain it", `Nora holds Share with everyone: ${nora.includes("sharing.share_org_wide")}; Maya: ${maya.includes("sharing.share_org_wide")}`, ok);
    expect(ok).toBe(true);
  });
});

test("an owner invites someone straight into the Engineering custom role, and they show with it wherever people are listed", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const email = `team-roles-invitee+${Date.now().toString(36)}@example.test`;

  await step("from the dashboard, the owner opens Members › Add member and sees custom roles in the Role picker", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "button", label: "Add member" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Add member" });
    await owner.type({ testId: "invite-email" }, email);
    await owner.click({ role: "button", label: "Role" });
    await owner.see({ role: "option", label: /^Engineering/ }, { timeoutMs: 15_000 });
    await owner.see({ role: "option", label: /^Admin/ });
    evidence.recordAssertionEvidence("The invite Role picker lists custom roles next to Member and Admin", "Engineering is offered as a role", true);
    await owner.screenshot();
  });

  await step("after: the invite goes out with Engineering, and the pending person is already in its team", async () => {
    await owner.click({ role: "option", label: /^Engineering/ });
    await owner.click({ role: "button", label: "Send invite" });
    await owner.see({ text: email }, { timeoutMs: 30_000 });
    const roster = await probe.api(world.owner, "/v1/org", { headers: world.scope });
    const members = isRecord(roster.body) && Array.isArray(roster.body.members) ? roster.body.members.filter(isRecord) : [];
    const pending = members.find((member) => isRecord(member.user) && member.user.email === email);
    const team = await probe.api(world.owner, `/v1/teams/${encodeURIComponent(world.teams.engineering)}`, { headers: world.scope });
    const memberIds = isRecord(team.body) && isRecord(team.body.team) && Array.isArray(team.body.team.memberIds) ? team.body.team.memberIds : [];
    const ok = Boolean(pending && typeof pending.id === "string" && memberIds.includes(pending.id) && pending.role === "member");
    evidence.recordAssertionEvidence("A custom role invites a Member into that role's team", `pending member role ${String(pending?.role)}; in Engineering: ${ok}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: the Teams list names each team's role, Member for Sales and Custom for Engineering", async () => {
    await owner.click({ role: "tab", label: /^Teams/ });
    // Sales is listed first; Engineering's Custom is the only "Custom" on the tab.
    await owner.see({ testId: "team-row-role" }, { text: "Member", timeoutMs: 30_000 });
    await owner.see({ text: "Custom" });
    evidence.recordAssertionEvidence("Teams list shows one role per team", "Sales Member, Engineering Custom", true);
    await owner.screenshot();
  });
});

test("an owner reads what the Engineering team can do from its team page; a member without team access can't open it", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const nora = user.on(world.noraWeb);

  await step("from the dashboard, the owner opens Members › Teams › Engineering", async () => {
    await owner.navigate(world.url("/dashboard"));
    await owner.see({ role: "link", label: "Members" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Members" });
    await owner.see({ role: "tab", label: /^Teams/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.see({ role: "link", label: "Engineering" }, { timeoutMs: 30_000 });
    await owner.click({ role: "link", label: "Engineering" });
    await owner.see({ testId: "team-role-name" }, { text: "Custom", timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("Three clicks from the dashboard to the team's role", "Members, Teams, Engineering", true);
  });

  await step("after: the role, what it adds, and what everyone can do are on one screen", async () => {
    await owner.see({ testId: "team-role-also" }, { text: /Share with everyone/, timeoutMs: 30_000 });
    await owner.see({ testId: "team-role-also" }, { text: /Create and remove marketplaces/ });
    await owner.see({ testId: "team-role-also" }, { text: /Import plugins from GitHub/ });
    await owner.see({ testId: "team-role-everyone" }, { text: /Make their own skills and plugins/ });
    const lee = await permissionsOf(probe, world, world.lee);
    const ok = ENGINEERING_KEYS.every((key) => lee.includes(key));
    evidence.recordAssertionEvidence("The page matches what Lee, in Engineering, actually holds", `Lee holds ${ENGINEERING_KEYS.filter((key) => lee.includes(key)).join(", ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("boundary: Nora, without View any team, is sent back to her dashboard and the API refuses the team", async () => {
    await nora.navigate(world.url(`/dashboard/members/teams/${encodeURIComponent(world.teams.engineering)}`));
    await nora.see({ text: "My Library" }, { timeoutMs: 60_000 });
    await nora.notSee({ testId: "team-role" });
    const team = await probe.api(world.nora, `/v1/teams/${encodeURIComponent(world.teams.engineering)}`, { headers: world.scope });
    const refused = team.response.status === 403 && isRecord(team.body) && team.body.requiredPermission === "teams.view";
    evidence.recordAssertionEvidence("A member without teams.view can't read another team's role", `Den Web shows her dashboard, not the team; GET /v1/teams/:engineering → ${team.response.status} requiredPermission ${isRecord(team.body) ? String(team.body.requiredPermission) : "none"}`, refused);
    expect(refused).toBe(true);
    await nora.screenshot();
  });
});
