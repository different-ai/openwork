import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record } from "../worlds/org-invite.ts";
import { ssoMultipleConnections } from "../worlds/sso-multiple-connections.ts";

const test = spec.world(ssoMultipleConnections, { timeout: 900_000, needs: { placement: "local", commands: ["pnpm"] }, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner runs several SSO connections and people choose their identity provider at sign-in", async ({ world, user, probe, step, evidence }) => {
  await step("the SSO page lists every connection with what it needs next", async () => {
    await user.see({ text: "Add SSO connection" }, { timeoutMs: 90_000 });
    await user.see({ text: "Microsoft Entra ID" }, { timeoutMs: 30_000 });
    const screen = await probe.text();
    const listed = ["Okta", "Microsoft Entra ID", "Partner Google Workspace", "Verify domain", "2 of 3 connections on"].filter((value) => screen.includes(value));
    evidence.recordAssertionEvidence("three connections listed, two on and one waiting for its DNS check", listed.join(" · "), listed.length === 5);
    expect(listed).toHaveLength(5);
    await user.screenshot();
  });

  await step("opening a connection shows its own domains, setup URLs and state", async () => {
    await user.click({ role: "button", label: "Manage Microsoft Entra ID" });
    await user.see({ text: "All connections" }, { timeoutMs: 30_000 });
    await user.see({ text: "Disable connection" }, { timeoutMs: 30_000 });
    const screen = await probe.text();
    const shown = screen.includes(world.mainDomain) && screen.includes(world.subsidiaryDomain);
    evidence.recordAssertionEvidence("Entra's page names both of its domains", `${world.mainDomain}, ${world.subsidiaryDomain}: ${shown ? "shown" : "missing"}`, shown);
    expect(shown).toBe(true);
    await user.screenshot();
  });

  await step("a connection waiting for its DNS check stays off and shows the record to publish", async () => {
    await user.click({ role: "button", label: "All connections" });
    await user.click({ role: "button", label: "Manage Partner Google Workspace" });
    await user.see({ text: "Verify your domain first" }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: "Request token" });
    const screen = await probe.text();
    const pending = screen.includes(world.partnerDomain) && screen.includes("Verify domain");
    evidence.recordAssertionEvidence("the partner connection stays off until its domain is verified", pending ? `${world.partnerDomain} pending verification` : "not shown", pending);
    expect(pending).toBe(true);
    await user.screenshot();
  });

  await step("adding another connection opens an empty form with a name for its sign-in button", async () => {
    await user.click({ role: "button", label: "All connections" });
    await user.click({ role: "button", label: "Add SSO connection" });
    await user.see({ text: "Name on the sign-in button" }, { timeoutMs: 30_000 });
    await user.see({ text: "Email domains" }, { timeoutMs: 30_000 });
    const screen = await probe.text();
    const empty = screen.includes("Add SSO connection") && !screen.includes("Disable connection");
    evidence.recordAssertionEvidence("the new connection form asks for a name and email domains", empty ? "Name on the sign-in button · Email domains · Add SSO connection" : "form not shown", empty);
    expect(empty).toBe(true);
    await user.screenshot();
  });

  await step("after: someone on the main domain gets one button per identity provider", async () => {
    const surface = await world.signedOut();
    const person = user.on(surface);
    await person.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await person.type({ role: "textbox", label: "Email" }, `someone@${world.mainDomain}`);
    await person.click({ role: "button", label: "Next" });
    await person.see({ role: "button", label: "Continue with Okta" }, { timeoutMs: 30_000 });
    await person.see({ role: "button", label: "Continue with Microsoft Entra ID" }, { timeoutMs: 30_000 });
    const options = await world.request(world.den.admin, `/v1/auth/login-options?email=${encodeURIComponent(`someone@${world.mainDomain}`)}`);
    const providers = record(options.body).ssoProviders;
    const names = Array.isArray(providers) ? providers.map((entry) => record(entry).name) : [];
    evidence.recordAssertionEvidence("sign-in offers the two enabled providers for the domain, not the unverified one", names.join(", "), names.length === 2);
    expect(names).toEqual(["Okta", "Microsoft Entra ID"]);
    await person.screenshot();
  });

  await step("someone on the subsidiary's domain only sees the provider that covers it", async () => {
    const surface = await world.signedOut();
    const person = user.on(surface);
    await person.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await person.type({ role: "textbox", label: "Email" }, `someone@${world.subsidiaryDomain}`);
    await person.click({ role: "button", label: "Next" });
    await person.see({ text: "Continue with Synthetic SSO organization SSO" }, { timeoutMs: 30_000 });
    await person.notSee({ text: "Continue with Okta" });
    const options = await world.request(world.den.admin, `/v1/auth/login-options?email=${encodeURIComponent(`someone@${world.subsidiaryDomain}`)}`);
    const providers = record(options.body).ssoProviders;
    const names = Array.isArray(providers) ? providers.map((entry) => record(entry).name) : [];
    evidence.recordAssertionEvidence("the subsidiary's email gets the single Entra connection", names.join(", "), names.length === 1);
    expect(names).toEqual(["Microsoft Entra ID"]);
    await person.screenshot();
  });

  await step("the organization's SSO link lets people pick their identity provider", async () => {
    const surface = await world.signedOut(`/sso/${world.orgSlug}`);
    const person = user.on(surface);
    await person.see({ role: "button", label: "Continue with Okta" }, { timeoutMs: 60_000 });
    await person.see({ role: "button", label: "Continue with Microsoft Entra ID" }, { timeoutMs: 30_000 });
    await person.notSee({ text: "Partner Google Workspace" });
    const options = await world.request(world.den.admin, `/v1/auth/sso-options?organizationSlug=${encodeURIComponent(world.orgSlug)}`);
    const providers = record(options.body).providers;
    const names = Array.isArray(providers) ? providers.map((entry) => record(entry).name) : [];
    evidence.recordAssertionEvidence("/sso/<organization> shows the two enabled providers", names.join(", "), names.length === 2);
    expect(names).toEqual(["Okta", "Microsoft Entra ID"]);
    await person.screenshot();
  });
});
