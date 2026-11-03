import { expect } from "vitest";
import { selfHostServer, spec } from "@openwork/testkit";
import { membersFor, record } from "../worlds/org-invite.ts";
import { SELF_HOST_INSTALLER_VERSION, selfHostInviteToDesktop } from "../worlds/self-host-install.ts";

const test = spec.world((seed, context) => selfHostInviteToDesktop(seed, context, selfHostServer), {
  resources: {
    surfaces: ["web", "appWeb"],
    services: ["den"],
  },
  needs: { placement: "local" },
  timeout: 900_000,
});

test("an invited teammate installs OpenWork from the private server and the app starts signed in to it", async ({ world, user, agent, probe, evidence, step }) => {
  const appUser = user.on(world.app);
  const webUser = user.on(world.web);
  // The invitation email links to the server's public address; stay on it so
  // the browser session follows the teammate from page to page.
  const site = new URL(world.invite.link).origin;

  await step("before: a freshly installed OpenWork app asks to sign in and knows no server", async () => {
    await appUser.see({ text: "Welcome to OpenWork" }, { timeoutMs: 180_000 });
    await appUser.see({ role: "button", label: "Using OpenWork on-premises?" });
    const status = record(await agent.on(world.app).run("auth.status"));
    expect(status.user).toBeNull();
    evidence.recordAssertionEvidence("The app starts with no account", `auth status=${String(status.status)}; user=none`, status.user === null);
    await appUser.screenshot();
  });

  await step("the invited teammate opens the emailed invitation, creates an account and joins", async () => {
    await webUser.navigate(world.invite.link);
    await webUser.see({ text: world.teammate.email }, { timeoutMs: 90_000 });
    await webUser.type({ role: "textbox", label: /^name$/i }, world.teammate.name);
    await webUser.type({ role: "textbox", label: /^password$/i }, world.teammate.password);
    await webUser.click({ role: "button", label: "Create account" });
    await webUser.see({ role: "button", label: `Join ${world.workspaceName}` }, { timeoutMs: 90_000 });
    await webUser.click({ role: "button", label: `Join ${world.workspaceName}` });
    await webUser.see({ text: "Set up OpenWork Enterprise" }, { timeoutMs: 90_000 });
    const members = membersFor(await world.witness.org(world.organizationId), world.teammate.email);
    expect(members).toEqual([expect.objectContaining({ role: "member" })]);
    evidence.recordAssertionEvidence("Joining lands the new member on the Enterprise install guide", `members with this email: ${members.length}; role=${String(members[0]?.role)}`, members.length === 1);
    await webUser.screenshot();
  });

  let address = "";
  await step("after: the plain install page gives the member the approved Enterprise app and the workspace address", async () => {
    const member = await world.sessionFor(world.teammate);
    const download = await world.download(member);
    expect(download.status).toBe(302);
    const asset = new URL(download.location ?? "").pathname.split("/").pop() ?? "";
    expect(asset).toBe(`openwork-enterprise-mac-arm64-${SELF_HOST_INSTALLER_VERSION}.dmg`);
    await webUser.click({ role: "button", label: "Already installed? Skip to step 3" });
    await webUser.see({ text: "In the app, enter your workspace address:" });
    address = await world.workspaceAddress(member);
    evidence.recordAssertionEvidence("The member's download is the Enterprise installer at the approved version", `GET /v1/me/install/mac-arm64 → ${download.status} ${asset}; workspace address ${address}`, download.status === 302);
    await webUser.screenshot();
  });

  await step("the member enters the workspace address in the app and continues to sign in", async () => {
    await appUser.click({ role: "button", label: "Using OpenWork on-premises?" });
    await appUser.see({ text: "Connect to your organization's server" });
    await appUser.type({ role: "textbox", label: "Organization server URL" }, address, { replace: true });
    await appUser.click({ role: "button", label: "Save" });
    await appUser.see({ text: `Connected to ${new URL(address).host}` }, { timeoutMs: 60_000 });
    await appUser.screenshot();
    await appUser.click({ role: "button", label: /^Sign in to / });
    const opened = await probe.eventually(() => world.appOpenedSignIn(), {
      within: 60_000, label: "the app opens sign-in in the browser", until: (value) => value !== null,
    });
    if (!opened) throw new Error("The app did not open sign-in in the browser.");
    expect(new URL(opened).origin).toBe(new URL(address).origin);
  });

  let deepLink = "";
  await step("the browser, already signed in, hands the member back to the app", async () => {
    const opened = await world.appOpenedSignIn();
    if (!opened) throw new Error("The app's sign-in page is gone.");
    await webUser.navigate(opened);
    await webUser.see({ testId: "desktop-signed-in-handoff" }, { timeoutMs: 90_000 });
    await webUser.see({ text: world.teammate.email });
    deepLink = await world.readHandoffLink();
    const handoff = new URL(deepLink);
    expect(handoff.protocol).toBe("openwork:");
    expect(handoff.hostname).toBe("den-auth");
    expect(handoff.searchParams.get("grant")).toBeTruthy();
    expect(handoff.searchParams.has("token")).toBe(false);
    await webUser.screenshot();
  });

  await step("after: the app receives the link and starts signed in to the private workspace", async () => {
    // The desktop shell receives openwork:// from the OS, reads the server's
    // published API address and exchanges the grant outside the browser's CORS
    // rules. The browser build can do none of that, so those two steps are
    // bridged: the real grant from the link goes to the app's documented
    // sign-in entry point with the address the server publishes.
    const handoff = new URL(deepLink);
    const apiBaseUrl = await world.publishedApiUrl(address);
    await agent.on(world.app).run("auth.exchange-grant", { grant: handoff.searchParams.get("grant") ?? "", baseUrl: address, apiBaseUrl });
    await appUser.see({ text: world.teammate.name }, { timeoutMs: 180_000 });
    await appUser.notSee({ text: /sign-in failure|something went wrong|temporarily unavailable/i });
    const status = record(await agent.on(world.app).run("auth.status"));
    const signedIn = record(status.user);
    expect(signedIn.email).toBe(world.teammate.email);
    evidence.recordAssertionEvidence("The app is signed in as the invited member on the private server", `auth status=${String(status.status)}; user=${String(signedIn.email)}`, signedIn.email === world.teammate.email);
    await appUser.screenshot();
  });

  await step("someone without an account gets a sign-in page, no installer, and no workspace name", async () => {
    const outsider = user.on(await world.signedOutBrowser());
    await outsider.navigate(new URL("/install", site).toString());
    await outsider.see({ role: "textbox", label: /email/i }, { timeoutMs: 90_000 });
    await outsider.notSee({ text: "Set up OpenWork Enterprise" });
    const download = await world.download(null);
    expect(download.status).toBe(401);
    const config = await world.publicInstallConfig();
    expect(config.status).toBe(200);
    expect(config.body.clientName).toBe("OpenWork");
    expect(JSON.stringify(config.body)).not.toContain(world.workspaceName);
    evidence.recordAssertionEvidence("Signed out, the server reveals neither its installer nor its workspace", `install page → sign-in; download → ${download.status}; public setup clientName=${String(config.body.clientName)}`, download.status === 401);
    await outsider.screenshot();
  });
});
