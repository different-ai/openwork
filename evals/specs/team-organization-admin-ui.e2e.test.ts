import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { permissionsUiWorld } from "../worlds/permissions-ui.ts";
import { parseTeamAdminContext } from "./helpers/team-admin-context.ts";

// Managing Admin teams belongs to the owner by default. Use the same real Den
// members world as the Permissions journey; trusted UI clicks grant and remove
// team Admin, while the inherited admin's checkbox stays visible but locked.
const test = spec.world(permissionsUiWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an owner grants team Admin while inherited admins keep Admin team changes locked", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const ownerProbe = probe.on(world.ownerWeb);
  const teammate = user.on(world.mayaWeb);
  const teammateProbe = probe.on(world.mayaWeb);
  const teamPath = `/dashboard/members/teams/${world.supportTeamId}`;
  const grantLabel = "Grant organisation Admin to all members of Support";
  const teammateContext = async () => {
    const response = await probe.api(world.maya, "/v1/org", { headers: world.scope });
    expect(response.response.status).toBe(200);
    return parseTeamAdminContext(response.body);
  };

  await step("before: the owner sees members and a readable, selectable Teams tab", async () => {
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "tab", label: /^Teams/ }, { timeoutMs: 60_000 });
    const typography = await world.typography();
    const ok = typography.inactiveTabs.length === 1 && typography.inactiveTabs.every((tab) => tab.contrast >= 4.5)
      && typography.memberBadges.length === 1 && typography.memberBadges.every((badge) => badge.text === "Owner" && badge.fontSize >= 11 && badge.textTransform === "none")
      && typography.memberEmails.length === 3 && typography.memberEmails.every((email) => email.contrast >= 4.5);
    evidence.recordAssertionEvidence("The shared member identity and inactive Teams tab remain readable", `tabs=${JSON.stringify(typography.inactiveTabs)}; badges=${JSON.stringify(typography.memberBadges)}; emails=${JSON.stringify(typography.memberEmails)}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the owner opens the team editor from a narrow-screen row action", async () => {
    await owner.resizeViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
    await owner.click({ role: "tab", label: /^Teams/ });
    await owner.see({ role: "link", label: "Support" });
    const controls = await ownerProbe.dom('[data-testid="team-row"] button');
    const typography = await world.typography();
    const fits = controls.viewportWidth === 390 && controls.documentWidth <= controls.viewportWidth && typography.bodyWidth <= typography.viewportWidth
      && controls.elements.length === 2 && controls.elements.every((element) => element.rect.left >= 0 && element.rect.right <= controls.viewportWidth && element.rect.width > 0);
    expect(fits).toBe(true);
    await owner.click({ role: "button", label: "Edit" });
    await owner.see({ role: "button", label: "Save team" });
    evidence.recordAssertionEvidence("Team row actions are reachable at 390px without page overflow", `viewport=${controls.viewportWidth}px; body=${typography.bodyWidth}px; Edit and Delete both fit; Edit opens the real team form`, fits);
    await owner.screenshot();
    await owner.click({ role: "button", label: "Cancel" });
  });

  await step("the owner grants Support members team Admin with the real checkbox", async () => {
    await owner.click({ role: "link", label: "Support" });
    await owner.see({ role: "checkbox", label: grantLabel }, { timeoutMs: 60_000 });
    const before = await ownerProbe.dom('input[type="checkbox"]:not(:checked):not(:disabled)');
    expect(before.elements.length).toBe(1);
    await owner.click({ role: "checkbox", label: grantLabel });
    const context = await probe.eventually(teammateContext, { within: 15_000, until: (value) => value.currentMember.role === "member,admin", label: "Support members inherit Admin" });
    await ownerProbe.eventually(() => ownerProbe.dom('input[type="checkbox"]:checked:not(:disabled)'), { within: 15_000, until: (value) => value.elements.length === 1, label: "saved Admin grant" });
    const typography = await world.typography();
    const readable = typography.inactiveTabs.length === 1 && typography.inactiveTabs.every((tab) => tab.contrast >= 4.5);
    evidence.recordAssertionEvidence("The checkbox persists the grant and the shared Overview tab stays readable", `Maya role=${context.currentMember.role}; grant checked and editable; inactive tab=${JSON.stringify(typography.inactiveTabs)}`, readable && context.currentMember.role === "member,admin");
    expect(readable).toBe(true);
    await owner.screenshot();
  });

  await step("after: the inherited admin sees the checked grant locked, with its owner and provenance", async () => {
    await teammate.navigate(world.url(teamPath));
    await teammate.see({ role: "checkbox", label: grantLabel }, { timeoutMs: 60_000 });
    await teammate.click({ role: "tab", label: "Overview" });
    await teammate.see({ text: "Admin via Support" });
    await teammate.see({ text: /Needs the “Manage Admin teams” permission\. Ask the organization owner\./ });
    const locked = await teammateProbe.dom('input[type="checkbox"]:checked:disabled');
    const context = await teammateContext();
    const typography = await world.typography("maya");
    const ok = locked.elements.length === 1 && context.currentMember.directRole === "member"
      && context.currentMember.adminTeams.some((team) => team.id === world.supportTeamId)
      && typography.inactiveTabs.length === 1 && typography.inactiveTabs.every((tab) => tab.contrast >= 4.5)
      && typography.memberEmails.length === 1 && typography.memberEmails.every((email) => email.contrast >= 4.5);
    evidence.recordAssertionEvidence("Inherited Admin does not grant Admin team management", `checked, disabled checkbox=${locked.elements.length}; direct role=${context.currentMember.directRole}; Admin via Support; locked reason names the owner; inactive tabs=${JSON.stringify(typography.inactiveTabs)}`, ok);
    expect(ok).toBe(true);
    await teammate.screenshot();
  });

  await step("the inherited admin can still read the locked checkbox and provenance on a narrow screen", async () => {
    await teammate.resizeViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
    await teammate.see({ role: "checkbox", label: grantLabel });
    await teammate.see({ text: "Admin via Support" });
    const labels = await teammateProbe.dom('label:has(input[type="checkbox"]:disabled)');
    const typography = await world.typography("maya");
    const ok = labels.viewportWidth === 390 && labels.documentWidth <= labels.viewportWidth && typography.bodyWidth <= typography.viewportWidth
      && labels.elements.length === 1 && labels.elements.every((element) => element.rect.left >= 0 && element.rect.right <= labels.viewportWidth)
      && typography.inactiveTabs.length === 1 && typography.inactiveTabs.every((tab) => tab.contrast >= 4.5);
    evidence.recordAssertionEvidence("The locked grant remains present and readable at 390px", `checkbox label bounds=${JSON.stringify(labels.elements.map((element) => element.rect))}; page=${labels.documentWidth}px; body=${typography.bodyWidth}px; inactive tabs=${JSON.stringify(typography.inactiveTabs)}`, ok);
    expect(ok).toBe(true);
    await teammate.screenshot();
  });

  await step("the owner removes team Admin without changing the member's direct role", async () => {
    await owner.see({ role: "checkbox", label: grantLabel });
    await owner.click({ role: "checkbox", label: grantLabel });
    const context = await probe.eventually(teammateContext, { within: 15_000, until: (value) => value.currentMember.role === "member", label: "team Admin removed" });
    await ownerProbe.eventually(() => ownerProbe.dom('input[type="checkbox"]:not(:checked):not(:disabled)'), { within: 15_000, until: (value) => value.elements.length === 1, label: "saved unchecked grant" });
    const ok = context.currentMember.directRole === "member" && context.currentMember.adminTeams.length === 0;
    evidence.recordAssertionEvidence("The narrow-screen owner checkbox also persists removal", `Maya role=${context.currentMember.role}; direct role=${context.currentMember.directRole}; inherited Admin teams=${context.currentMember.adminTeams.length}; owner checkbox unchecked and editable`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });
});
