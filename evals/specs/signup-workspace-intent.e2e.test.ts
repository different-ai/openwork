import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { signupWorkspace } from "../worlds/signup-workspace.ts";

// New journey: an account with no organization makes its first personal/team
// choice, optionally invites people, then reviews the ready workspace.
const test = spec.world(signupWorkspace, { timeout: 600_000 });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

test("signup distinguishes joining, personal work, and restricted team setup without changing another organization", async ({ world, user, probe, seed, evidence, step }) => {
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
    await probe.eventually(() => probe.eval("Boolean(document.querySelector('[data-testid=auth-landing-visual] canvas'))"), { within: 15000, label: "Paper shader canvas", until: (visible) => visible === true });
    await user.looks(["The signup landing shows Good work starts here alongside a clear email entry form within a restrained black-and-white setup frame, with a compact black-and-white dithered texture band above the form"]);
    await user.type({ role: "textbox", label: "Email" }, world.owner.email);
    await user.click({ role: "button", label: "Next" });
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
    const memberships = await orgs();
    expect(memberships).toHaveLength(1);
    const personal = memberships.find((entry) => entry.name === "Personal work");
    if (typeof personal?.id !== "string") throw new Error("Personal organization missing");
    personalId = personal.id;
    personalPolicy = await policyFor(personalId);
    expect(personalPolicy.allowMultipleWorkspaces).toBe(true);
    expect(personalPolicy.allowManageExtensions).toBe(true);
    expect(await invitationsFor(personalId)).toEqual([]);
    const outboxBeforeSkip = await inviteEmails();
    await user.type({ role: "textbox", label: "Teammate email 1" }, "unsent@openwork.test");
    await user.click({ role: "button", label: "Do this later" });
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    const connectionsBeforeSkip = await connectionsFor(personalId);
    expect(connectionsBeforeSkip).toEqual([]);
    await user.click({ role: "checkbox", label: "Add Notion" });
    await user.click({ role: "button", label: "Do this later" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    expect(await connectionsFor(personalId)).toEqual(connectionsBeforeSkip);
    evidence.recordAssertionEvidence("Skipping optional tools does not save even a selected connection", "Notion was selected, then Do this later continued to Ready; the personal organization's connection inventory stayed empty.", true);
    await user.click({ text: "Other platforms and versions" });
    await user.see({ text: "macOS" });
    await user.see({ text: "Windows" });
    await user.see({ text: "Linux" });
    expect(await probe.eval("document.querySelectorAll('[data-testid=download-openwork-card] details a[href]').length")).toBe(8);
    await user.click({ text: "Other platforms and versions" });
    await user.looks(["The final setup screen shows a clear desktop download and model setup path in the same restrained black-and-white design"]);
    expect(await invitationsFor(personalId)).toEqual([]);
    expect(await inviteEmails()).toEqual(outboxBeforeSkip);
    evidence.recordAssertionEvidence("Personal setup preserves desktop defaults and explicit skip never submits a typed invitation", JSON.stringify({ memberships: memberships.length, personalPolicy, invitations: [], emailsUnchanged: true }), true);
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
    await user.looks(["The optional Tools screen shows Notion and Linear added for the team while explaining that each person still signs in to their own account, with a clear Continue action"]);
    await user.reload();
    await user.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    expect(await connectionsFor(flexibleId)).toEqual(added);
    await user.see({ text: "Already added" });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
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
    expect(await world.pathname()).toMatch(/\/onboarding\/people$/);
    expect(await policyFor(team.id)).toEqual(saved);
    const policies = await probe.api(world.den.admin, "/v1/desktop-policies", { headers: { "x-openwork-org-id": team.id } });
    expect(policies.response.ok).toBe(true);
    if (!isRecord(policies.body) || !Array.isArray(policies.body.desktopPolicies)) throw new Error("Expected desktop policies");
    const defaultPolicy = policies.body.desktopPolicies.filter(isRecord).find((entry) => entry.isDefault === true);
    if (typeof defaultPolicy?.id !== "string") throw new Error("Expected default desktop policy id");
    await user.navigate(new URL(`/dashboard/desktop-policies/${encodeURIComponent(defaultPolicy.id)}?setup=restricted`, world.den.ref.webUrl).toString());
    await user.see({ text: "Bring your people." }, { timeoutMs: 90_000 });
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
    expect(await connectionsFor(team.id)).toEqual([]);
    await user.click({ role: "button", label: "Do this later" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    expect(await connectionsFor(team.id)).toEqual([]);
    expect(await connectionsFor(personalId)).toEqual([]);
    expect(await invitationsFor(team.id)).toEqual([]);
    expect(await invitationsFor(flexibleId)).toHaveLength(2);
    evidence.recordAssertionEvidence("Restricted setup saves the real desktop policy before opening People, survives reload, and leaves other organizations unchanged", JSON.stringify({ saved, retainedAfterReload: true, legacySetupContinuesToPeople: true, personalPolicy, orgCount: 3, restrictedInvitations: 0, flexibleInvitations: 2 }), true);
  });
  await step("mobile setup offers a download email or web access after reviewing team tools", async () => {
    const selected = await seed.api(world.den.admin, "/v1/me/active-organization", {
      method: "POST", body: JSON.stringify({ organizationId: flexibleId }),
    });
    expect(selected.response.ok).toBe(true);
    const mobile = await seed.web({
      den: world.den, signedInAs: world.den.admin, startPath: "/dashboard/onboarding/tools",
      headless: true, viewport: { width: 390, height: 844 },
    });
    const mobileUser = user.on(mobile);
    const downloadEmails = async () => {
      const result = await probe.api(world.den.admin, "/v1/dev/emails?template=downloadLink");
      expect(result.response.ok).toBe(true);
      if (!isRecord(result.body) || !Array.isArray(result.body.emails)) throw new Error("Expected download email outbox");
      return result.body.emails.filter(isRecord).map(({ template, to, subject, at }) => ({ template, to, subject, at }));
    };
    const toolsBefore = await connectionsFor(flexibleId);
    await mobileUser.see({ text: "Give your team a head start." }, { timeoutMs: 90_000 });
    await mobileUser.see({ text: "Already added" });
    expect(await probe.eval(mobile, "document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    await mobileUser.looks(["The narrow Tools screen has readable tool choices and progress, with no horizontal clipping and a clear way to continue"]);
    await mobileUser.click({ role: "button", label: "Continue" });
    await mobileUser.see({ testId: "onboarding-mobile-options" }, { timeoutMs: 90_000 });
    await mobileUser.notSee({ testId: "download-openwork-card" });
    await mobileUser.see({ role: "button", label: "Email me the download link" });
    await mobileUser.see({ role: "link", label: "Try OpenWork Web" });
    expect(await probe.eval(mobile, "document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    expect(await connectionsFor(flexibleId)).toEqual(toolsBefore);
    await mobileUser.looks(["Mobile setup ends with a clear choice to email the desktop download link or try OpenWork Web, using the OpenWork mark and restrained neutral cards instead of desktop platform downloads"]);
    const before = await downloadEmails();
    await mobileUser.click({ role: "button", label: "Email me the download link" });
    await mobileUser.see({ role: "button", label: "Download link sent" }, { timeoutMs: 30_000 });
    const sent = await probe.eventually(downloadEmails, {
      within: 30_000, label: "the real download email is captured for the signed-in owner", until: (emails) => emails.length === before.length + 1,
    });
    expect(sent.filter((email) => email.to === world.owner.email)).toHaveLength(before.filter((email) => email.to === world.owner.email).length + 1);
    expect(await probe.eval(mobile, `Array.from(document.querySelectorAll('[data-testid="onboarding-mobile-options"] button')).find((button) => button.textContent.trim() === "Download link sent")?.disabled`)).toBe(true);
    await mobileUser.click({ role: "button", label: "Download link sent" });
    expect(await downloadEmails()).toEqual(sent);
    expect(await probe.eval(mobile, `Array.from(document.querySelectorAll('[data-testid="onboarding-mobile-options"] a')).find((link) => link.textContent.trim() === "Try OpenWork Web")?.getAttribute("href")`)).toBe("/dashboard/web");
    await mobileUser.click({ role: "link", label: "Try OpenWork Web" });
    await probe.eventually(() => probe.eval(mobile, "window.location.pathname"), {
      within: 30_000, label: "mobile web option opens the existing access and plans page", until: (path) => path === "/dashboard/web",
    });
    evidence.recordAssertionEvidence("Mobile setup preserves configured tools, sends one real download email to the signed-in owner, disables repeat sends, and links to web access without starting checkout", JSON.stringify({ recipient: world.owner.email, newDownloadEmails: 1, repeatSendDisabled: true, webRoute: "/dashboard/web", configuredToolsUnchanged: true }), true);
  });
  await step("the public signup also fits a narrow screen", async () => {
    const mobile = await seed.web({ den: world.den, startPath: "/", headless: true, viewport: { width: 390, height: 844 } });
    const mobileUser = user.on(mobile);
    await mobileUser.see({ text: "Good work starts here." }, { timeoutMs: 90_000 });
    await mobileUser.see({ role: "textbox", label: "Email" });
    expect(await probe.eval(mobile, "document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    await mobileUser.looks(["The narrow signup screen has legible progress steps, heading, and email form without horizontal clipping"]);
  });

});
