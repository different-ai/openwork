import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { mcpConsentClientIdentity } from "../worlds/mcp-consent-client-identity.ts";

const test = spec.world(mcpConsentClientIdentity, {
  timeout: 300_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("a member sees that an app is unverified and can decline MCP access", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.web);
  const browser = probe.on(world.web);

  async function seeUnverifiedWarning(redirectUri: string) {
    await person.see({ testId: "mcp-unverified-app-warning" });
    await person.see({ text: "Unverified application" });
    await person.see({ text: "OpenWork has not verified who is requesting this access. Only authorize if you started this connection and trust the app to act on your behalf with the permissions shown." });
    await person.see({ text: "Check the return host supplied by this app:" });
    const host = new URL(redirectUri).host;
    await person.see({ testId: "mcp-warning-redirect-host", text: host });
    expect((await browser.dom('[data-testid="mcp-warning-redirect-host"]')).elements.map(element => element.text.trim())).toEqual([host]);
    expect((await browser.dom('[data-testid="mcp-unverified-app-warning"]')).elements.some(element => element.text.includes(redirectUri))).toBe(false);
    await person.notSee({ testId: "mcp-client-domain" });
    await person.notSee({ testId: "mcp-redirect-url" });
    expect((await browser.dom('details:not([open]):has([data-testid="mcp-redirect-url"])')).elements).toHaveLength(1);
    await person.click({ text: "Technical details" });
    await person.see({ testId: "mcp-redirect-url", text: redirectUri });
    expect((await browser.dom('details[open] [data-testid="mcp-redirect-url"]')).elements).toHaveLength(1);
    expect((await browser.dom('[data-testid="mcp-redirect-url"]')).elements.map(element => element.text.trim())).toEqual([redirectUri]);
    expect((await browser.dom('a[data-testid="mcp-redirect-url"], a:has([data-testid="mcp-redirect-url"]), [data-testid="mcp-redirect-url"] a')).elements).toHaveLength(0);
    expect((await browser.dom('[data-testid="mcp-redirect-url"] *')).elements).toHaveLength(0);
    await person.click({ text: "Technical details" });
    await person.notSee({ testId: "mcp-redirect-url" });
    expect((await browser.dom('details:not([open]):has([data-testid="mcp-redirect-url"])')).elements).toHaveLength(1);
    await person.see({ testId: "mcp-warning-redirect-host", text: host });
  }

  await step("given a member who signs in from the app's authorization link", async () => {
    await person.navigate(world.loopback.url);
    await person.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 90_000 });
    await person.type({ role: "textbox", label: /^email$/i }, world.admin.email);
    await person.click({ role: "button", label: "Next" });
    await person.type({ role: "textbox", label: /^password$/i }, world.admin.password);
    await person.click({ role: "button", label: "Sign in" });
    evidence.recordAssertionEvidence("The member signs in through the normal sign-in page", world.admin.email, true);
  });

  await step("after: an app returning to this computer shows both unverified-app and loopback warnings", async () => {
    await person.see({ testId: "mcp-client-name", text: world.loopback.name }, { timeoutMs: 90_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.loopback.redirectHost });
    await person.see({ testId: "mcp-loopback-warning" });
    await seeUnverifiedWarning(world.loopback.redirectUri);
    evidence.recordAssertionEvidence(
      "The workspace chooser warns that the named loopback app is unverified",
      `App "${world.loopback.name}"; return host ${world.loopback.redirectHost} visible; full return address verified as plain text only after expanding Technical details, then collapsed again; unverified-app and loopback warnings shown`,
      true,
    );
    await person.screenshot();
  });

  await step("after: a named hosted app is still unverified, without a loopback warning", async () => {
    await person.navigate(world.hosted.url);
    await person.see({ testId: "mcp-client-name", text: world.hosted.name }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.hosted.redirectHost });
    await person.notSee({ testId: "mcp-loopback-warning" });
    await seeUnverifiedWarning(world.hosted.redirectUri);
    evidence.recordAssertionEvidence(
      "A public return address does not make the app verified",
      `App "${world.hosted.name}"; return host ${world.hosted.redirectHost} visible; full return address verified as plain text only after expanding Technical details, then collapsed again; unverified-app warning shown; no loopback warning`,
      true,
    );
    await person.screenshot();
  });

  await step("the card shows the app's registered name, never its raw client identifier", async () => {
    await person.see({ testId: "mcp-client-name", text: world.hosted.name });
    await person.notSee({ text: world.hosted.clientId });
    await person.see({ text: "Use your connected tools, including actions that create, change, or delete data" });
    evidence.recordAssertionEvidence("No opaque client id on the card", `client id ${world.hosted.clientId.slice(0, 6)}… absent; name "${world.hosted.name}" shown; mcp:write listed as "Use your connected tools, including actions…"`, true);
  });

  await step("after: an unnamed app shows the unverified warning alongside the host to check", async () => {
    await person.navigate(world.unnamed.url);
    await person.see({ testId: "mcp-client-name", text: "An app without a name" }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.unnamed.redirectHost });
    await person.see({ testId: "mcp-unnamed-app-line" });
    await person.see({ text: `This app did not share its name. Only continue if you know ${world.unnamed.redirectHost} and started this sign-in.` });
    await person.see({ role: "button", label: "Authorize this app" });
    await seeUnverifiedWarning(world.unnamed.redirectUri);
    evidence.recordAssertionEvidence("An unnamed app retains its guidance and is explicitly unverified", `Return host ${world.unnamed.redirectHost} visible; full return address verified as plain text only after expanding Technical details, then collapsed again; unverified-app warning and unnamed-app guidance shown`, true);
    await person.screenshot();
  });

  await step("after: hosted-app consent repeats the unverified warning before the member decides", async () => {
    await person.navigate(await world.consentUrl(world.hosted.authorizePath));
    await person.see({ text: `Allow ${world.hosted.name} to use` }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.hosted.redirectHost });
    await seeUnverifiedWarning(world.hosted.redirectUri);
    await person.notSee({ testId: "mcp-loopback-warning" });
    await person.see({ role: "button", label: `Authorize ${world.hosted.name}` });
    await person.see({ role: "button", label: "Deny" });
    evidence.recordAssertionEvidence("Hosted-app consent warns before authorization", `App "${world.hosted.name}"; return host ${world.hosted.redirectHost} visible; full return address verified as plain text only after expanding Technical details, then collapsed again; unverified-app warning, Authorize and Deny visible; no loopback warning`, true);
    await person.screenshot();
  });

  await step("the consent step names the app, the workspace and the return address, with Deny as a quiet action", async () => {
    await person.navigate(await world.consentUrl(world.loopback.authorizePath));
    await person.see({ text: `Allow ${world.loopback.name} to use` }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-redirect-host", text: world.loopback.redirectHost });
    await person.see({ testId: "mcp-loopback-warning" });
    await seeUnverifiedWarning(world.loopback.redirectUri);
    await person.see({ role: "button", label: `Authorize ${world.loopback.name}` });
    await person.see({ role: "button", label: "Deny" });
    await person.notSee({ text: /OpenWork MCP|Authorize MCP access/ });
    evidence.recordAssertionEvidence("Loopback consent retains both warnings and a way to decline", `App "${world.loopback.name}"; return host ${world.loopback.redirectHost} visible; full return address verified as plain text only after expanding Technical details, then collapsed again; unverified-app and loopback warnings, Authorize and Deny visible`, true);
    await person.screenshot();
  });

  await step("when the member denies the unverified app, it receives no authorization code", async () => {
    expect(world.callbacks()).toHaveLength(0);
    await person.click({ role: "button", label: "Deny" });
    await person.see({ text: "Authorization returned to client" }, { timeoutMs: 30_000 });
    expect(world.callbacks()).toEqual([{ hasCode: false, error: "access_denied", state: world.loopback.state }]);
    evidence.recordAssertionEvidence("Declining grants no authorization code", "One Deny click returned access_denied with the original state and no authorization code to the local client.", true);
    await person.screenshot();
  });

  await step("an unnamed app's consent step names the host to check", async () => {
    await person.navigate(await world.consentUrl(world.unnamed.authorizePath));
    await person.see({ text: "Allow this app to use" }, { timeoutMs: 60_000 });
    await person.see({ testId: "mcp-unnamed-app-line" });
    await seeUnverifiedWarning(world.unnamed.redirectUri);
    evidence.recordAssertionEvidence("Unnamed-app consent retains both warnings", `Return host ${world.unnamed.redirectHost} visible; full return address verified as plain text only after expanding Technical details, then collapsed again; unverified-app warning and unnamed-app guidance shown`, true);
    await person.screenshot();
  });
});
