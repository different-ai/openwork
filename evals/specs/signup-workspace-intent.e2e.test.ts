import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { signupWorkspace } from "../worlds/signup-workspace.ts";
import { desktopOnboardingWorld } from "../../scenarios/onboarding/world.ts";

// New journey: an account with no organization makes its first personal/team
// choice, optionally invites people, then reviews the ready workspace.
// This journey cold-boots Den and three browser surfaces; each individual
// interaction remains bounded below, including the final signed-out mobile view.
const test = spec.world((seed) => signupWorkspace(seed), { timeout: 900_000 });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

test("signup distinguishes joining, personal work, and restricted team setup without changing another organization", async ({ world, user, probe, seed, evidence, step }) => {
  const expectNoHorizontalOverflow = async (surfaceProbe = probe) => {
    const snapshot = await surfaceProbe.dom("html");
    expect(snapshot.documentWidth).toBeLessThanOrEqual(snapshot.viewportWidth);
  };
  const expectFocusedSetup = async () => {
    await user.see({ testId: "den-onboarding-shell" });
    await user.notSee({ testId: "den-org-sidebar" });
    await user.notSee({ role: "button", label: "Open menu" });
    const [frameBounds, footer, story, panel, brand, progress] = await Promise.all([
      '[data-testid="setup-frame"]', '[data-testid="setup-frame"] footer', '[data-testid="setup-frame"] aside',
      '[data-testid="setup-frame"] aside + div', '[data-testid="setup-frame"] header > div', 'nav[aria-label="Setup progress"]',
    ].map(async (selector) => {
      const snapshot = await probe.dom(selector);
      expect(snapshot.elements).toHaveLength(1);
      return snapshot.elements[0].rect;
    }));
    const { viewportWidth } = await probe.dom("html");
    expect(Math.abs(frameBounds.left) < 2
        && Math.abs(frameBounds.right - viewportWidth) < 2
        && Math.abs(panel.right - story.left - 1130) < 2
        && Math.abs(footer.left - story.left) < 2
        && Math.abs(footer.right - panel.right) < 2
        && story.right <= panel.left && Math.abs(story.top - panel.top) < 2
        && Math.abs(brand.left - story.left) < 2
        && Math.abs(progress.left - panel.left) < 2
        && Math.abs(progress.right - panel.right) < 2).toBe(true);
    await expectNoHorizontalOverflow();
  };
  const orgs = async () => {
    const result = await probe.api(world.den.admin, "/v1/me/orgs");
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.orgs)) throw new Error("Expected organization list");
    return result.body.orgs.filter(isRecord);
  };
  const policyFor = async (id: string) => {
    const result = await probe.api(world.den.admin, "/v1/desktop-policies", { headers: { "x-openwork-org-id": id } });
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.desktopPolicies)) throw new Error("Expected desktop policies");
    const policy = result.body.desktopPolicies.filter(isRecord).find((entry) => entry.isDefault === true);
    if (!policy || !isRecord(policy.policy)) throw new Error("Expected default desktop policy");
    return policy.policy;
  };

  const invitationsFor = async (id: string) => {
    const result = await probe.api(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": id } });
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.invitations)) throw new Error("Expected invitations");
    return result.body.invitations.filter(isRecord).map(({ email, role, status }) => ({ email, role, status }));
  };
  const connectionsFor = async (id: string) => {
    const result = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable", { headers: { "x-openwork-org-id": id } });
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.connections)) throw new Error("Expected MCP connection list");
    return result.body.connections.filter(isRecord).map(({ id, name, authType, credentialMode, connectedForMe, access }) => ({
      id, name, authType, credentialMode, connectedForMe,
      orgWide: isRecord(access) ? access.orgWide : undefined,
    }));
  };
  const inviteEmails = async () => {
    const result = await probe.api(world.den.admin, "/v1/dev/emails?template=organizationInvite");
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.emails)) throw new Error("Expected development email outbox");
    return result.body.emails.filter(isRecord).map((entry) => entry.to);
  };

  await step("a person arrives at signup and creates their actual account", async () => {
    await user.see({ text: "Good work starts here." }, { timeoutMs: 90_000 });
    await user.see({ role: "textbox", label: "Email" });
    await user.notSee({ role: "textbox", label: "Team name" });
    await user.see({ testId: "auth-landing-visual" });
    await user.see({ text: "Your choice of model. One place to work." });
    await probe.eventually(async () => (await probe.dom('[data-testid="auth-landing-visual"] canvas')).elements.length > 0, { within: 15000, label: "Paper shader canvas", until: (visible) => visible === true });
    await user.looks(["The signup landing shows Good work starts here alongside a clear email entry form within a restrained black-and-white setup frame, with a compact black-and-white dithered texture band above the form. The product example clearly shows a chat conversation, an inline dashboard result, and a composer with provider choice"]);
    await user.type({ role: "textbox", label: "Email" }, world.owner.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ testId: "signup-new-account" });
    await user.click({ role: "textbox", label: "Name" });
    expect((await probe.dom('[data-testid="signup-new-account"] input[autocomplete="name"]')).elements[0]?.focused).toBe(true);
    for (const selector of ['input[autocomplete="email"]', 'input[autocomplete="new-password"]', 'button[type="submit"]', 'button[type="button"]']) {
      await user.press("Tab");
      expect((await probe.dom(`[data-testid="signup-new-account"] ${selector}`)).elements[0]?.focused).toBe(true);
    }
    expect((await probe.dom('[data-testid="signup-new-account"] > button, [data-testid="signup-new-account"] > .den-divider')).elements.map(({ text }) => text)).toEqual(["Sign up", "or", "Sign up with Google"]);
    await user.type({ role: "textbox", label: "Name" }, world.owner.name);
    await user.type({ role: "textbox", label: "Password" }, world.owner.password);
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ text: "Make it yours." }, { timeoutMs: 90_000 });
    await world.adoptSignedInOwner();
    expect(await orgs()).toEqual([]);
    evidence.recordAssertionEvidence("Signup begins at the public account screen and account creation does not create an organization", "The visible email/name/password form created the account; its organization list remained empty before choosing how to work.", true);
  });

  await step("a fresh account can review joining without creating an organization", async () => {
    await user.see({ text: "Make it yours." }, { timeoutMs: 90_000 });
    await user.see({ text: "A little about your work." });
    await user.notSee({ role: "textbox", label: "Organization name" });
    expect(await orgs()).toEqual([]);
    await user.click({ text: "Join a team" });
    await user.type({ role: "textbox", label: /^Team invitation link/ }, "https://example.test/join-org?invite=not-valid");
    await user.click({ role: "button", label: "Review invitation" });
    await user.see({ text: /Paste the invitation link for this OpenWork Cloud/ });
    expect(await orgs()).toEqual([]);
    await user.type({ role: "textbox", label: /^Team invitation link/ }, new URL("/join-org?invite=missing-invitation", world.den.ref.webUrl).toString(), { replace: true });
    await user.click({ role: "button", label: "Review invitation" });
    await probe.eventually(() => world.pathname(), { within: 30_000, label: "existing invite review route", until: (path) => path === "/join-org" });
    expect(await orgs()).toEqual([]);
    evidence.recordAssertionEvidence("Join uses invitation review and neither an invalid link nor review creates an organization", "Foreign origin rejected; same-origin invitation opened /join-org; organization list remained empty", true);
  });

  let personalId = "";
  let personalPolicy: Record<string, unknown> = {};
  await step("personal work creates one organization and can skip inviting without sending anything", async () => {
    await user.navigate(new URL("/organization", world.den.ref.webUrl).toString());
    await user.see({ text: "Make it yours." }, { timeoutMs: 90_000 });
    await user.click({ text: "On my own" });
    await user.notSee({ text: "How should your team’s desktop app work?" });
    await user.type({ role: "textbox", label: "Organization name" }, "Personal work");
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    const memberships = await orgs();
    expect(memberships).toHaveLength(1);
    const personal = memberships.find((entry) => entry.name === "Personal work");
    if (typeof personal?.id !== "string") throw new Error("Personal organization missing");
    personalId = personal.id;
    personalPolicy = await policyFor(personalId);
    expect(personalPolicy.allowMultipleWorkspaces).toBe(true);
    expect(personalPolicy.allowManageExtensions).toBe(true);
    const policies = await probe.api(world.den.admin, "/v1/desktop-policies", { headers: { "x-openwork-org-id": personalId } });
    expect(policies.response.ok).toBe(true);
    if (!isRecord(policies.body) || !Array.isArray(policies.body.desktopPolicies)) throw new Error("Expected desktop policies");
    const defaultPolicy = policies.body.desktopPolicies.filter(isRecord).find((entry) => entry.isDefault === true);
    if (typeof defaultPolicy?.id !== "string") throw new Error("Expected default desktop policy id");
    await user.navigate(new URL(`/dashboard/desktop-policies/${encodeURIComponent(defaultPolicy.id)}?setup=restricted`, world.den.ref.webUrl).toString());
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await world.pathname()).toMatch(/\/onboarding\/people$/);
    expect(await policyFor(personalId)).toEqual(personalPolicy);
    await user.reload();
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await policyFor(personalId)).toEqual(personalPolicy);
    evidence.recordAssertionEvidence("Opening a legacy Restricted setup link never changes an existing flexible policy", "The personal workspace kept its complete original desktop policy after opening the legacy URL and reloading; navigation only resumed optional People onboarding.", true);
    expect(await invitationsFor(personalId)).toEqual([]);
    const outboxBeforeSkip = await inviteEmails();
    await user.type({ role: "textbox", label: "Teammate email 1" }, "unsent@openwork.test");
    await user.click({ role: "button", label: "Do this later" });
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    const connectionsBeforeSkip = await connectionsFor(personalId);
    expect(connectionsBeforeSkip).toEqual([]);
    await user.click({ role: "checkbox", label: "Add Notion" });
    await user.click({ role: "button", label: "Do this later" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await connectionsFor(personalId)).toEqual(connectionsBeforeSkip);
    evidence.recordAssertionEvidence("Skipping optional tools does not save even a selected connection", "Notion was selected, then Do this later continued to Ready; the personal organization's connection inventory stayed empty.", true);
    await user.notSee({ testId: "download-openwork-card" });
    await user.notSee({ text: "Other platforms and versions" });
    await user.see({ testId: "onboarding-choice-openwork-models" });
    await user.see({ testId: "onboarding-choice-byok" });
    await user.looks(["The final setup screen focuses on optional model choices and a clear completion button, without a download or installation checklist"]);
    expect(await invitationsFor(personalId)).toEqual([]);
    expect(await inviteEmails()).toEqual(outboxBeforeSkip);
    evidence.recordAssertionEvidence("Personal setup preserves desktop defaults and explicit skip never submits a typed invitation", JSON.stringify({ memberships: memberships.length, personalPolicy, invitations: [], emailsUnchanged: true }), true);
  });

  await step("finish opens the dashboard without requiring an installation or provider", async () => {
    for (const shortcut of ["Control+k", "Meta+k"]) {
      if (shortcut === "Meta+k") {
        await user.navigate(new URL("/dashboard/onboarding", world.den.ref.webUrl).toString());
      }
      await user.see({ text: "Your workspace is ready" });
      await user.notSee({ testId: "den-org-sidebar" });
      await user.press(shortcut);
      await user.notSee({ testId: "den-command-palette" });
      await user.click({ role: "button", label: "Complete setup" });
      await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 30_000 });
      await user.notSee({ testId: "den-onboarding-shell" });
      expect(await world.pathname()).toBe("/dashboard");
      // Assert before reload: navigation must not reveal a queued shortcut.
      await user.notSee({ testId: "den-command-palette" });
      await user.press(shortcut);
      await user.see({ testId: "den-command-palette" });
      await user.press("Escape");
      await user.notSee({ testId: "den-command-palette" });
      evidence.recordAssertionEvidence(`${shortcut} is suppressed during onboarding and restored on the dashboard`, "Pressing the shortcut during setup leaves the palette closed both before and after completion, without reloading; pressing it on the dashboard opens the palette, and Escape closes it.", true);
    }
    await user.reload();
    await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 30_000 });
    expect(await connectionsFor(personalId)).toEqual([]);
    expect(await invitationsFor(personalId)).toEqual([]);
    evidence.recordAssertionEvidence("Setup keeps two panes and hides dashboard navigation until completion", "People, Tools and Ready fill the viewport with a 1130px desktop content area and matching footer edges, with the logo aligned to the story and the stepper aligned to both panel edges, without the sidebar or menu; completion opens /dashboard and restores navigation, including after reload, with no tools or invitations required.", true);
  });

  let flexibleId = "";
  await step("a flexible team keeps existing defaults without opening policy setup", async () => {
    await user.navigate(new URL("/organization", world.den.ref.webUrl).toString());
    await user.click({ role: "button", label: "+ Create New Organization" });
    await user.click({ text: "Create a team" });
    await user.type({ role: "textbox", label: "Team name" }, "Flexible team");
    await user.click({ text: "Flexible" });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    await user.notSee({ text: "Review your team’s desktop access" });
    const memberships = await orgs();
    expect(memberships).toHaveLength(2);
    const flexible = memberships.find((entry) => entry.name === "Flexible team");
    if (typeof flexible?.id !== "string") throw new Error("Flexible organization missing");
    flexibleId = flexible.id;
    expect(await policyFor(flexibleId)).toEqual(personalPolicy);
    expect(await policyFor(personalId)).toEqual(personalPolicy);
    evidence.recordAssertionEvidence("Flexible team creation continues to optional invitations and leaves both its defaults and the existing personal organization unchanged", JSON.stringify({ count: memberships.length, policy: personalPolicy }), true);
  });

  await step("optional invitations reject duplicates and retry only an unsuccessful row", async () => {
    // Arrange a real server rejection for one row, without replacing product APIs.
    const limited = await seed.api(world.den.admin, "/v1/org", {
      method: "PATCH", headers: { "x-openwork-org-id": flexibleId },
      body: JSON.stringify({ allowedEmailDomains: ["openwork.test"] }),
    });
    expect(limited.response.ok).toBe(true);
    expect(await invitationsFor(flexibleId)).toEqual([]);
    const outboxBefore = await inviteEmails();
    await user.type({ role: "textbox", label: "Teammate email 1" }, world.invitees[0]);
    await user.type({ role: "textbox", label: "Teammate email 2" }, world.invitees[0].toUpperCase());
    await user.click({ role: "button", label: "Send invitations" });
    await user.see({ text: "Use a different email address for each person." });
    expect(await invitationsFor(flexibleId)).toEqual([]);
    expect(await inviteEmails()).toEqual(outboxBefore);
    evidence.recordAssertionEvidence("Duplicate invitation emails are refused before any request is saved or sent", "Case-insensitive duplicate rows produced a visible error, zero invitations, and an unchanged development outbox.", true);

    await user.type({ role: "textbox", label: "Teammate email 2" }, world.rejectedEmail, { replace: true });
    await user.click({ role: "button", label: "Send invitations" });
    try {
      await user.see({ text: "Invitation sent" });
    } catch (error) {
      await user.screenshot();
      const screenText = await probe.text();
      const formStart = screenText.indexOf("Who would you like to invite?");
      const formText = formStart >= 0 ? screenText.slice(formStart) : screenText;
      const invitations = await invitationsFor(flexibleId);
      throw new Error(`First invitation did not show success. Form: ${formText.slice(0, 3000)}\nPersisted invitations: ${JSON.stringify(invitations)}`, { cause: error });
    }
    await user.see({ text: "This workspace only allows openwork.test email addresses." });
    await user.see({ role: "textbox", label: "Teammate email 2" }, { value: world.rejectedEmail, editable: true });
    expect(await invitationsFor(flexibleId)).toEqual([{ email: world.invitees[0], role: "member", status: "pending" }]);
    expect((await inviteEmails()).filter((email) => email === world.invitees[0])).toHaveLength(1);
    expect((await inviteEmails()).includes(world.rejectedEmail)).toBe(false);
    await user.screenshot();

    await user.type({ role: "textbox", label: "Teammate email 2" }, world.invitees[1], { replace: true });
    await user.click({ role: "button", label: "Send invitations" });
    await user.see({ text: "2 invitations sent." });
    const invitations = await invitationsFor(flexibleId);
    expect(invitations).toHaveLength(2);
    for (const email of world.invitees) {
      expect(invitations).toContainEqual({ email, role: "member", status: "pending" });
      expect((await inviteEmails()).filter((recipient) => recipient === email)).toHaveLength(1);
    }
    expect(await invitationsFor(personalId)).toEqual([]);
    expect(await policyFor(personalId)).toEqual(personalPolicy);
    await user.looks(["The optional people setup shows two completed invitations and a clear Continue action within the same neutral onboarding frame"]);
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    evidence.recordAssertionEvidence("Partial invitation failure preserves the unsuccessful address and retries it without resending successful invitations or granting admin access", JSON.stringify({ invitations, recipientCounts: [1, 1], personalInvitations: 0 }), true);
  });

  await step("optional tools add shared availability without authorizing anyone's account", async () => {
    expect(await world.pathname()).toMatch(/\/onboarding\/tools$/);
    expect(await connectionsFor(flexibleId)).toEqual([]);
    await user.see({ text: "Adding a tool makes it available to your team. Each teammate connects their own account before accessing private information." });
    await user.click({ role: "checkbox", label: "Add Notion" });
    await user.click({ role: "checkbox", label: "Add Linear" });
    await user.click({ role: "button", label: "Add to team" });
    await user.see({ role: "button", label: "Continue" }, { timeoutMs: 90_000 });
    const added = await probe.eventually(() => connectionsFor(flexibleId), {
      within: 30_000, label: "both selected OAuth presets are configured in the team", until: (items) => items.length === 2,
    });
    for (const name of ["Notion", "Linear"]) {
      expect(added.find((connection) => connection.name === name)).toMatchObject({
        authType: "oauth", credentialMode: "per_member", connectedForMe: false, orgWide: true,
      });
    }
    expect(await connectionsFor(personalId)).toEqual([]);
    await user.see({ text: "Added to team" });
    await user.looks(["The optional Tools screen shows Notion and Linear added for the team while explaining that each person still signs in to their own account, with a clear Continue action. Its product example is a chat with inline team tools and a persistent composer"]);
    await user.reload();
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await connectionsFor(flexibleId)).toEqual(added);
    await user.see({ text: "Already added" });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await connectionsFor(flexibleId)).toEqual(added);
    evidence.recordAssertionEvidence("Selected tools become organization-wide configuration without authorizing member accounts or creating duplicates on reload", JSON.stringify({ added, personalConnections: [], sameConnectionsAfterReload: true }), true);
  });

  await step("Restricted setup applies desktop policy before opening optional invitations", async () => {
    await user.navigate(new URL("/organization", world.den.ref.webUrl).toString());
    await user.click({ role: "button", label: "+ Create New Organization" });
    await user.click({ text: "Create a team" });
    await user.type({ role: "textbox", label: "Team name" }, "Focused team");
    await user.see({ text: "How should your team’s desktop app work?" });
    await user.click({ text: "Flexible" });
    await user.see({ role: "button", label: "Continue" });
    await user.click({ text: "Restricted" });
    await user.see({ text: "Restricted requires Enterprise. We’ll apply the team’s desktop restrictions when you continue. You can change them later in Settings." });
    await user.looks(["Team setup uses subdued neutral cards with Restricted selected, without heavy black card outlines, and explains that restrictions apply on Continue"]);
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await world.pathname()).toMatch(/\/onboarding\/people$/);
    await user.notSee({ text: "Review your team’s desktop access" });
    await user.notSee({ role: "button", label: "Save changes" });
    const memberships = await orgs();
    expect(memberships).toHaveLength(3);
    const team = memberships.find((entry) => entry.name === "Focused team");
    if (typeof team?.id !== "string") throw new Error("Created team missing");
    const saved = await policyFor(team.id);
    for (const key of ["allowCustomProviders", "allowZenModel", "allowMultipleWorkspaces", "allowControlSettings", "allowManageExtensions", "allowBuiltInExtensions", "allowAlphaUpdates"]) expect(saved[key]).toBe(false);
    expect(saved.showWelcomePage).toBe(true);
    await user.reload();
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await world.pathname()).toMatch(/\/onboarding\/people$/);
    expect(await policyFor(team.id)).toEqual(saved);
    const policies = await probe.api(world.den.admin, "/v1/desktop-policies", { headers: { "x-openwork-org-id": team.id } });
    expect(policies.response.ok).toBe(true);
    if (!isRecord(policies.body) || !Array.isArray(policies.body.desktopPolicies)) throw new Error("Expected desktop policies");
    const defaultPolicy = policies.body.desktopPolicies.filter(isRecord).find((entry) => entry.isDefault === true);
    if (typeof defaultPolicy?.id !== "string") throw new Error("Expected default desktop policy id");
    await user.navigate(new URL(`/dashboard/desktop-policies/${encodeURIComponent(defaultPolicy.id)}?setup=restricted`, world.den.ref.webUrl).toString());
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await world.pathname()).toMatch(/\/onboarding\/people$/);
    await user.notSee({ text: "Review your team’s desktop access" });
    await user.notSee({ role: "button", label: "Save changes" });
    expect(await policyFor(team.id)).toEqual(saved);
    expect(await policyFor(personalId)).toEqual(personalPolicy);
    expect(await policyFor(flexibleId)).toEqual(personalPolicy);
    expect(await orgs()).toHaveLength(3);
    expect(await invitationsFor(team.id)).toEqual([]);
    await user.click({ role: "button", label: "Do this later" });
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await connectionsFor(team.id)).toEqual([]);
    await user.click({ role: "button", label: "Do this later" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    await expectFocusedSetup();
    expect(await connectionsFor(team.id)).toEqual([]);
    expect(await connectionsFor(personalId)).toEqual([]);
    expect(await invitationsFor(team.id)).toEqual([]);
    expect(await invitationsFor(flexibleId)).toHaveLength(2);
    evidence.recordAssertionEvidence("Restricted setup saves the real desktop policy before opening People, survives reload, and leaves other organizations unchanged", JSON.stringify({ saved, retainedAfterReload: true, legacySetupContinuesToPeople: true, personalPolicy, orgCount: 3, restrictedInvitations: 0, flexibleInvitations: 2 }), true);
  });
  await step("mobile setup completes after optional model choices without a download", async () => {
    const selected = await seed.api(world.den.admin, "/v1/me/active-organization", {
      method: "POST", body: JSON.stringify({ organizationId: flexibleId }),
    });
    expect(selected.response.ok).toBe(true);
    const mobile = await seed.web({
      den: world.den, signedInAs: world.den.admin, startPath: "/dashboard/onboarding/tools",
      headless: true, viewport: { width: 390, height: 844 },
    });
    const mobileUser = user.on(mobile);
    const toolsBefore = await connectionsFor(flexibleId);
    await mobileUser.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await mobileUser.see({ text: "Already added" });
    await mobileUser.notSee({ role: "button", label: "Open menu" });
    await mobileUser.notSee({ testId: "den-org-sidebar" });
    await expectNoHorizontalOverflow(probe.on(mobile));
    await mobileUser.press("Control+Home");
    await mobileUser.looks(["The top of the narrow Tools screen shows legible setup progress and the Give your team a head start heading without horizontal clipping"]);
    await mobileUser.hover({ role: "button", label: "Continue" });
    await mobileUser.looks(["The lower part of the narrow Tools screen shows readable tool cards and a clear Continue button without horizontal clipping"]);
    await mobileUser.click({ role: "button", label: "Continue" });
    await mobileUser.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    await mobileUser.notSee({ testId: "download-openwork-card" });
    await mobileUser.notSee({ role: "button", label: "Email me the download link" });
    await mobileUser.see({ testId: "onboarding-choice-openwork-models" });
    await mobileUser.see({ testId: "onboarding-choice-byok" });
    await expectNoHorizontalOverflow(probe.on(mobile));
    expect(await connectionsFor(flexibleId)).toEqual(toolsBefore);
    await mobileUser.hover({ role: "button", label: "Complete setup" });
    await mobileUser.looks(["The mobile final setup screen shows optional model choices and a legible Complete setup action, without downloads or horizontal clipping"]);
    await mobileUser.notSee({ role: "button", label: "Open menu" });
    await mobileUser.click({ role: "button", label: "Complete setup" });
    await mobileUser.see({ role: "button", label: "Open menu" }, { timeoutMs: 30_000 });
    await mobileUser.notSee({ testId: "den-onboarding-shell" });
    await mobileUser.click({ role: "button", label: "Open menu" });
    await mobileUser.see({ testId: "den-org-sidebar", nth: 1 });
    evidence.recordAssertionEvidence("Mobile onboarding finishes without downloading and reveals working dashboard navigation", "Tools and Ready omit the menu; completion restores it and opening the menu reveals the sidebar. Configured tools are unchanged.", true);
  });
  await step("the public signup also fits a narrow screen", async () => {
    const mobile = await seed.web({ den: world.den, startPath: "/", headless: true, viewport: { width: 390, height: 844 } });
    const mobileUser = user.on(mobile);
    await mobileUser.see({ text: "Good work starts here." }, { timeoutMs: 90_000 });
    await mobileUser.see({ role: "textbox", label: "Email" });
    await mobileUser.see({ text: "Your choice of model. One place to work." });
    await expectNoHorizontalOverflow(probe.on(mobile));
    await mobileUser.looks(["The narrow signup screen has legible progress steps, heading, email form, and model-provider choice without horizontal clipping"]);
  });

});

const desktopTest = spec.world(desktopOnboardingWorld, { timeout: 600_000 });

desktopTest("desktop-origin signup completes the questions before issuing a fresh grant, while returning members skip them", async ({ world, user, probe, seed, step, evidence }) => {
  const noHandoff = () => expect(world.handoff()).toEqual({ grants: 0, modelWrites: 0, returns: [] });
  const modelsOff = async () => {
    const result = await probe.api(world.den.admin, "/v1/inference", { headers: { "x-openwork-org-id": orgId } });
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !isRecord(result.body.inference)) throw new Error("Expected inference state");
    expect(result.body.inference.enabled).toBe(false);
  };
  const desktopUrl = new URL("/?mode=sign-up&desktopAuth=1&desktopScheme=openwork&intent=models", world.den.ref.webUrl).toString();
  let orgId = "";

  await step("desktop signup starts full setup rather than returning immediately", async () => {
    await user.navigate(desktopUrl);
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.owner.email);
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Name" }, world.owner.name);
    await user.type({ role: "textbox", label: "Password" }, world.owner.password);
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ text: "Make it yours." }, { timeoutMs: 90_000 });
    await world.adoptSignedInOwner();
    noHandoff();
    await user.reload();
    await user.see({ text: "Make it yours." }, { timeoutMs: 90_000 });
    noHandoff();
    await user.click({ text: "On my own" });
    await user.type({ role: "textbox", label: "Organization name" }, "Desktop workspace");
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    const result = await probe.api(world.den.admin, "/v1/me/orgs");
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.orgs)) throw new Error("Expected org directory");
    expect(result.body.orgs).toHaveLength(1);
    const org = result.body.orgs[0];
    if (!isRecord(org) || typeof org.id !== "string") throw new Error("Expected created org");
    orgId = org.id;
    noHandoff();
  });

  await step("resuming People and reloading Tools restore the setup org after a shared-session switch", async () => {
    const created = await seed.api(world.den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Other workspace" }) });
    expect(created.response.ok).toBe(true);
    if (!isRecord(created.body) || !isRecord(created.body.organization) || typeof created.body.organization.id !== "string") throw new Error("Expected second workspace");
    const otherOrgId = created.body.organization.id;
    const token = await probe.storage("openwork:web:auth-token");
    if (typeof token !== "string" || !token) throw new Error("Expected the browser's authenticated session");
    // Use the same session as the browser, not the separate API witness login.
    const browserSession = { ...world.den.admin, token };
    const setupWrites = async (id: string) => {
      const headers = { "x-openwork-org-id": id };
      const [org, connections] = await Promise.all([
        probe.api(world.den.admin, "/v1/org", { headers }),
        probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable", { headers }),
      ]);
      expect(org.response.ok).toBe(true);
      expect(connections.response.ok).toBe(true);
      if (!isRecord(org.body) || !Array.isArray(org.body.invitations) || !isRecord(connections.body) || !Array.isArray(connections.body.connections)) throw new Error("Expected setup write witnesses");
      return { invitations: org.body.invitations.filter(isRecord), connections: connections.body.connections.filter(isRecord) };
    };
    const expectActiveOrg = async (id: string) => {
      const active = await probe.api(browserSession, "/v1/me/orgs");
      expect(active.response.ok).toBe(true);
      if (!isRecord(active.body)) throw new Error("Expected active organization");
      expect(active.body.activeOrgId).toBe(id);
    };
    const switchElsewhere = async () => {
      const switched = await seed.api(browserSession, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: otherOrgId }) });
      expect(switched.response.ok).toBe(true);
      await expectActiveOrg(otherOrgId);
    };
    const otherBefore = await setupWrites(otherOrgId);
    await switchElsewhere();
    await user.navigate(new URL("/", world.den.ref.webUrl).toString());
    await user.see({ role: "textbox", label: "Teammate email 1" }, { timeoutMs: 90_000 });
    await user.see({ text: "Desktop workspace" });
    await expectActiveOrg(orgId);
    await user.reload();
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
    noHandoff();
    await user.type({ role: "textbox", label: "Teammate email 1" }, "resumed-teammate@openwork.test");
    await user.click({ role: "button", label: "Send invitations" });
    await user.see({ text: "Invitation sent" }, { timeoutMs: 30_000 });
    expect((await setupWrites(orgId)).invitations).toContainEqual(expect.objectContaining({ email: "resumed-teammate@openwork.test", role: "member", status: "pending" }));
    expect(await setupWrites(otherOrgId)).toEqual(otherBefore);
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await user.see({ role: "checkbox", label: "Add Notion" });
    await switchElsewhere();
    await user.reload();
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await user.see({ role: "checkbox", label: "Add Notion" });
    await expectActiveOrg(orgId);
    noHandoff();
    await user.click({ role: "checkbox", label: "Add Notion" });
    await user.click({ role: "button", label: "Add to team" });
    await user.see({ text: "Added to team" }, { timeoutMs: 90_000 });
    expect((await setupWrites(orgId)).connections).toContainEqual(expect.objectContaining({ name: "Notion", connectedForMe: false }));
    expect(await setupWrites(otherOrgId)).toEqual(otherBefore);
    await user.click({ role: "button", label: "Continue" });
    await user.see({ text: "Your workspace is ready" }, { timeoutMs: 90_000 });
    expect((await probe.dom("#setup-models-heading")).elements[0]?.focused).toBe(true);
    await user.notSee({ testId: "download-openwork-card" });
    await user.notSee({ role: "button", label: "Email me the download link" });
    await user.see({ role: "button", label: "Complete and open the app" });
    noHandoff();
    await modelsOff();
    // Model/provider settings stay usable; returning to Ready does not complete setup.
    await user.click({ role: "link", label: "Add a provider" });
    await user.see({ role: "link", label: "Back to setup" }, { timeoutMs: 90_000 });
    expect(await world.pathname()).toBe("/dashboard/custom-llm-providers");
    await user.reload();
    await user.see({ role: "link", label: "Back to setup" }, { timeoutMs: 90_000 });
    expect(await world.pathname()).toBe("/dashboard/custom-llm-providers");
    noHandoff();
    await user.click({ role: "link", label: "Back to setup" });
    await user.see({ role: "button", label: "Complete and open the app" }, { timeoutMs: 90_000 });
    await user.reload();
    await user.see({ role: "button", label: "Complete and open the app" }, { timeoutMs: 90_000 });
    expect((await probe.dom("#setup-models-heading")).elements[0]?.focused).toBe(true);
    noHandoff();
    evidence.recordAssertionEvidence("Desktop signup retains all setup steps across reloads without a grant", "Make it yours, People, Tools, Ready and an optional provider-settings detour survived reloads. Browser request witness recorded zero grants, model writes and desktop returns before completion.", true);
    evidence.recordAssertionEvidence("A shared-session org switch cannot retarget unfinished setup", "The browser's exact session was switched to another org before resuming People from / and before reloading Tools. Both restored the saved setup org; the invitation and Notion configuration were written only there, while the other org remained unchanged.", true);
  });

  await step("completion issues the real one-time grant for the intended organization without enabling models", async () => {
    await user.click({ role: "button", label: "Complete and open the app" });
    const handoff = await probe.eventually(() => world.handoff(), { within: 30_000, label: "browser requests OS return", until: (value) => value.returns.length === 1 });
    expect(handoff.grants).toBe(1);
    expect(handoff.modelWrites).toBe(0);
    const link = new URL(handoff.returns[0]);
    expect(link.protocol).toBe("openwork:");
    expect(link.hostname).toBe("den-auth");
    const grant = link.searchParams.get("grant");
    expect(grant).toBeTruthy();
    // Stand in for the OS recipient; consume only the grant the browser actually issued.
    const exchange = await seed.api(world.den.admin, "/v1/auth/desktop-handoff/exchange", { method: "POST", body: JSON.stringify({ grant }) });
    expect(exchange.response.ok).toBe(true);
    if (!isRecord(exchange.body)) throw new Error("Expected handoff exchange");
    expect(exchange.body.organization).toMatchObject({ id: orgId, name: "Desktop workspace" });
    expect(exchange.body.user).toMatchObject({ email: world.owner.email });
    await modelsOff();
    evidence.recordAssertionEvidence("Completion returns a fresh browser-issued grant for the new workspace with models off", "The browser requested the OpenWork protocol URL once; the mock OS recipient exchanged that exact grant for the intended user and organization. No model writes occurred and inference remained disabled.", true);
  });

  await step("an existing member returns directly even when the URL says sign-up", async () => {
    await user.navigate(desktopUrl);
    await user.see({ testId: "desktop-signed-in-handoff" }, { timeoutMs: 90_000 });
    await user.notSee({ text: "Make it yours." });
    const returning = await probe.eventually(() => world.handoff(), { within: 30_000, label: "returning member handoff", until: (value) => value.returns.length === 2 });
    expect(returning.grants).toBe(2);
    expect(returning.returns[1]).not.toBe(returning.returns[0]);
    expect(returning.modelWrites).toBe(0);
    await modelsOff();
  });
});
