import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ssoBrowser } from "../worlds/sso-browser.ts";
import { record } from "../worlds/org-invite.ts";

const test = spec.world(ssoBrowser, { timeout: 900_000, needs: { placement: "local", commands: ["pnpm", "openssl"] }, resources: { surfaces: ["web"], services: ["den", "mock"] } });

test("an owner keeps optional password access, verifies SAML, and safely requires it", async ({ world, user, probe, step, evidence }) => {
  const enterSettings = async (actor = user, browser = probe, organization = "Synthetic SSO organization") => {
    const screen = await browser.eventually(() => browser.text(), { within: 90_000, label: "settings or workspace choice", until: (value) => value.includes("Choose an organization") || value.includes("Single sign-on requirement") });
    if (screen.includes("Choose an organization")) {
      await actor.click({ role: "button", label: new RegExp(organization) });
      await browser.eventually(() => browser.text(), { within: 30_000, label: "organization selection finished", until: (value) => !value.includes("Choose an organization") });
      await actor.navigate(`${world.den.ref.webUrl}/dashboard/org-settings`);
    }
    await actor.see({ text: "Single sign-on requirement" }, { timeoutMs: 60_000 });
  };
  await step("optional SSO offers an ordinary password sign-in", async () => {
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.owner.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ role: "button", label: "Use another sign-in method" }, { timeoutMs: 30_000 });
    await user.screenshot();
    await user.click({ role: "button", label: "Use another sign-in method" });
    await user.type({ role: "textbox", label: "Password" }, world.owner.password, { sensitive: true });
    await user.click({ role: "button", label: /^Sign in$/ });
    await probe.eventually(() => probe.text(), { within: 30_000, label: "password sign-in completed", until: (value) => value.includes("Choose an organization") || value.includes("My Library") });
    await user.navigate(`${world.den.ref.webUrl}/dashboard/org-settings`);
    await enterSettings();
    const session = await world.sessionFor(world.web);
    const opened = await world.request(session, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } });
    evidence.recordAssertionEvidence("the password browser opens the optional SSO organization", `HTTP ${opened.response.status}`, opened.response.ok);
    expect(opened.response.status).toBe(200);
    await user.screenshot();
  });

  await step("a password administrator gets a working SSO recovery link", async () => {
    await user.click({ role: "switch", label: "Require SSO for this organization" });
    await user.click({ role: "button", label: "Save settings" });
    await user.see({ role: "link", label: "Sign in with SSO" }, { timeoutMs: 30_000 });
    await user.screenshot();
    await user.click({ role: "link", label: "Sign in with SSO" });
    await user.see({ role: "heading", label: "Synthetic organization sign-in" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("the recovery link reaches the local SAML provider", new URL(await probe.url()).origin, new URL(await probe.url()).origin === world.idp.origin);
    await user.screenshot();
  });

  await step("a tampered SAML response cannot upgrade the password session", async () => {
    await user.click({ role: "button", label: "Send invalid response" });
    await probe.eventually(() => probe.url(), { within: 30_000, label: "invalid assertion returns to Den", until: (value) => new URL(value).origin === world.den.ref.webUrl });
    const session = await world.sessionFor(world.web);
    const denied = await world.request(session, "/v1/org", { method: "PATCH", headers: { "x-openwork-org-id": world.orgId }, body: JSON.stringify({ requireSso: true }) });
    expect(denied.response.status, denied.text).toBe(409);
    evidence.recordAssertionEvidence("invalid SAML did not authorize enforcement", `Require SSO HTTP ${denied.response.status}; tampered responses=${world.idp.events.filter((event) => event.tampered).length}`, denied.response.status === 409);
    await user.screenshot();
    await user.navigate(`${world.den.ref.webUrl}/sso/${world.orgSlug}?callbackURL=${encodeURIComponent(`${world.den.ref.webUrl}/dashboard/org-settings`)}`);
    await user.see({ role: "heading", label: "Synthetic organization sign-in" }, { timeoutMs: 30_000 });
  });

  await step("after a signed SAML callback the owner can require SSO", async () => {
    await user.click({ role: "button", label: "Approve sign-in" });
    await enterSettings();
    await user.click({ role: "switch", label: "Require SSO for this organization" });
    await user.click({ role: "button", label: "Save settings" });
    const session = await world.sessionFor(world.web);
    const saved = await probe.eventually(() => world.request(session, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } }), { within: 20_000, label: "required SSO persisted", until: (value) => value.text.includes('"requireSso":true') || value.text.includes('\\"requireSso\\":true') });
    const metadata = record(saved.body).organization;
    evidence.recordAssertionEvidence("the signed SAML browser enabled Require SSO", `HTTP ${saved.response.status}; signed responses=${world.idp.events.length}; policy=${JSON.stringify(metadata).includes("requireSso")}`, saved.response.ok);
    expect(saved.response.ok).toBe(true);
    await user.screenshot();
  });
  await step("a fresh password browser keeps its other organization but cannot bypass required SSO", async () => {
    const surface = await world.fresh();
    const member = user.on(surface);
    await member.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
    await member.type({ role: "textbox", label: "Email" }, world.owner.email);
    await member.click({ role: "button", label: "Next" });
    await member.click({ role: "button", label: "Use another sign-in method" });
    await member.type({ role: "textbox", label: "Password" }, world.owner.password, { sensitive: true });
    await member.screenshot();
    await member.click({ role: "button", label: /^Sign in$/ });
    await probe.on(surface).eventually(() => probe.on(surface).text(), { within: 30_000, label: "fresh password sign-in completed", until: (value) => value.includes("Choose an organization") || value.includes("My Library") });
    await member.navigate(`${world.den.ref.webUrl}/dashboard/org-settings`);
    await enterSettings(member, probe.on(surface), "Synthetic other organization");
    const session = await world.sessionFor(surface);
    const other = await world.request(session, "/v1/org", { headers: { "x-openwork-org-id": world.otherId } });
    expect(other.response.status).toBe(200);
    const statuses: number[] = [];
    for (const [path, method, body] of [
      ["/v1/org", "GET", undefined],
      ["/v1/me/active-organization", "POST", { organizationId: world.orgId }],
      ["/v1/api-keys", "POST", { name: "Disallowed password key" }],
      ["/v1/mcp/token", "POST", { scopes: ["mcp:read"] }],
    ] satisfies [string, string, unknown][]) {
      const denied = await world.request(session, path, { method, headers: { "x-openwork-org-id": world.orgId }, ...(body ? { body: JSON.stringify(body) } : {}) });
      statuses.push(denied.response.status);
      expect(denied.response.status, denied.text).toBe(403);
    }
    evidence.recordAssertionEvidence("password access stays in the other organization, with every protected issuance denied", `other=${other.response.status}; header/set-active/API-key/MCP=${statuses.join("/")}`, statuses.every((status) => status === 403));
    await member.screenshot();
    await member.click({ testId: "workspace-switcher-trigger" });
    await member.click({ role: "button", label: /Synthetic SSO organization/ });
    await member.see({ role: "heading", label: "Synthetic organization sign-in" }, { timeoutMs: 30_000 });
    await member.screenshot();
    await member.click({ role: "button", label: "Approve sign-in" });
    await enterSettings(member, probe.on(surface));
    const sso = await world.sessionFor(surface);
    const allowed = await world.request(sso, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } });
    expect(allowed.response.status, allowed.text).toBe(200);
    await member.click({ testId: "workspace-switcher-trigger" });
    await member.click({ role: "button", label: /Synthetic SSO organization/ });
    await probe.on(surface).eventually(() => probe.on(surface).dom('[data-testid="workspace-switcher-trigger"]'), { within: 30_000, label: "verified SSO workspace becomes active", until: (value) => value.elements.some((entry) => entry.text.includes("Synthetic SSO organization")) });
    await member.navigate(`${world.den.ref.webUrl}/dashboard/org-settings`);
    await member.see({ text: "Single sign-on requirement" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("switching to the protected organization reaches SAML and resolves after its callback", `protected organization HTTP ${allowed.response.status}; signed responses=${world.idp.events.length}`, allowed.response.ok);
    await member.screenshot();
  });

  await step("an invited person on the claimed domain joins only the other organization normally", async () => {
    const surface = await world.fresh(world.invitePath);
    const invited = user.on(surface);
    await invited.see({ role: "textbox", label: /^name$/i }, { timeoutMs: 90_000 });
    await invited.type({ role: "textbox", label: /^name$/i }, world.invitee.name);
    await invited.type({ role: "textbox", label: /^password$/i }, world.invitee.password, { sensitive: true });
    await invited.screenshot();
    await invited.click({ role: "button", label: "Create account" });
    await invited.see({ role: "button", label: "Join Synthetic other organization" }, { timeoutMs: 30_000 });
    await invited.click({ role: "button", label: "Join Synthetic other organization" });
    // A brand-new member enters the real install/onboarding route after joining.
    await invited.see({ text: "Download OpenWork" }, { timeoutMs: 60_000 });
    const session = await world.sessionFor(surface);
    const memberships = await world.request(session, "/v1/me/orgs");
    const orgs = record(memberships.body).orgs;
    expect(orgs).toEqual([expect.objectContaining({ id: world.otherId })]);
    evidence.recordAssertionEvidence("the normal invitation flow creates exactly the invited membership", "one organization; no SAML callback for the invitee", Array.isArray(orgs) && orgs.length === 1);
    expect(world.idp.events.some((event) => event.email === world.invitee.email)).toBe(false);
    await invited.screenshot();
  });

});


test("a signed SAML callback independently gives the owner a verified organization session", async ({ world, user, probe, step, evidence }) => {
  await step("the owner starts the real SAML browser redirect", async () => {
    await user.navigate(`${world.den.ref.webUrl}/sso/${world.orgSlug}?callbackURL=${encodeURIComponent(`${world.den.ref.webUrl}/dashboard/org-settings`)}`);
    await user.see({ role: "heading", label: "Synthetic organization sign-in" }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("the browser received an AuthnRequest at the local provider", new URL(await probe.url()).origin, new URL(await probe.url()).origin === world.idp.origin);
    await user.screenshot();
  });
  await step("the provider posts a signed assertion back into Den", async () => {
    await user.click({ role: "button", label: "Approve sign-in" });
    const screen = await probe.eventually(() => probe.text(), { within: 90_000, label: "SAML returned to Den", until: (value) => value.includes("Choose an organization") || value.includes("Single sign-on requirement") });
    if (screen.includes("Choose an organization")) {
      await user.click({ role: "button", label: /Synthetic SSO organization/ });
      await probe.eventually(() => probe.text(), { within: 30_000, label: "workspace selected", until: (value) => !value.includes("Choose an organization") });
      await user.navigate(`${world.den.ref.webUrl}/dashboard/org-settings`);
    }
    await user.see({ text: "Single sign-on requirement" }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("Den accepted the real signed SAML callback", `signed responses=${world.idp.events.length}; Den settings visible`, world.idp.events.length === 1 && !world.idp.events[0].tampered);
    await user.screenshot();
  });
  await step("the authenticated owner enables the requirement without a 409", async () => {
    await user.click({ role: "switch", label: "Require SSO for this organization" });
    await user.click({ role: "button", label: "Save settings" });
    const session = await world.sessionFor(world.web);
    const result = await probe.eventually(() => world.request(session, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } }), { within: 20_000, label: "verified owner requirement saved", until: (value) => value.text.includes('\\"requireSso\\":true') || value.text.includes('"requireSso":true') });
    evidence.recordAssertionEvidence("the callback-created browser session can enforce SSO", `HTTP ${result.response.status}; requireSso=true`, result.response.ok);
    expect(result.response.status).toBe(200);
    await user.screenshot();
  });
  await step("the owner asks members for SSO again after a day", async () => {
    await user.click({ role: "button", label: "Ask for SSO again" });
    await user.click({ role: "option", label: "After 1 day" });
    await user.click({ role: "button", label: "Save settings" });
    const session = await world.sessionFor(world.web);
    const result = await probe.eventually(() => world.request(session, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } }), { within: 20_000, label: "SSO max age saved", until: (value) => value.text.includes('\\"ssoSessionMaxAgeHours\\":24') || value.text.includes('"ssoSessionMaxAgeHours":24') });
    const kept = result.text.includes('\\"requireSso\\":true') || result.text.includes('"requireSso":true');
    evidence.recordAssertionEvidence("the limit is saved and Require SSO is left as it was", `HTTP ${result.response.status}; ssoSessionMaxAgeHours=24; requireSso kept=${kept}`, result.response.ok && kept);
    expect(kept).toBe(true);
    await user.see({ role: "button", label: "Ask for SSO again" });
    await user.screenshot();
  });
  await step("Require SSO does not undo the password alternative for other organizations", async () => {
    const surface = await world.fresh();
    const actor = user.on(surface);
    const browser = probe.on(surface);
    await actor.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
    await actor.type({ role: "textbox", label: "Email" }, world.owner.email);
    await actor.click({ role: "button", label: "Next" });
    await actor.click({ role: "button", label: "Use another sign-in method" });
    await actor.type({ role: "textbox", label: "Password" }, world.owner.password, { sensitive: true });
    await actor.click({ role: "button", label: /^Sign in$/ });
    const screen = await browser.eventually(() => browser.text(), { within: 30_000, label: "password alternative result", until: (value) => value.includes("My Library") || value.includes("Choose an organization") || value.includes("Local test identity provider") });
    const ordinarySignIn = !screen.includes("Local test identity provider");
    evidence.recordAssertionEvidence("the password preflight permits ordinary sign-in for other organizations", ordinarySignIn ? "ordinary authenticated organization screen" : "incorrectly forced back to the SAML provider", ordinarySignIn);
    await actor.screenshot();
    expect(ordinarySignIn).toBe(true);
  });
});
