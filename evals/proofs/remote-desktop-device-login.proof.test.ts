import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record, text } from "../worlds/org-invite.ts";
import { remoteDesktopDeviceLogin } from "../worlds/remote-desktop-device-login.ts";

const test = spec.world(remoteDesktopDeviceLogin, {
  resources: {
    surfaces: ["desktop", "web"], services: ["den"],
    nativeReason: "The real shell command calls Electron's authenticated loopback control bridge; device polling and durable enrollment belong to that native app, not a browser substitute.",
  },
  timeout: 900_000,
});

test("a remote desktop signs in with its own session to the workspace chosen on another computer", async ({ world, user, agent, probe, step, evidence }) => {
  const desktop = agent.on(world.app);
  const appUser = user.on(world.app);
  const browser = user.on(world.web);
  let userCode = "";

  await step("before: device sign-in is off by default while existing terminal clients remain available", async () => {
    await appUser.see({ text: "Welcome to OpenWork" }, { timeoutMs: 180_000 });
    expect(await world.features()).toBe(false);
    const start = record(await desktop.run("auth.device-login.start", world.args));
    expect(start.state).toBe("unsupported");
    const denied = await world.codeStatus();
    expect(denied.error).toBe("invalid_client");
    const cli = await world.codeStatus("openwork-cli");
    const plugin = await world.codeStatus("openwork-opencode-plugin");
    expect(cli.status).toBe(200);
    expect(plugin.status).toBe(200);
    evidence.recordAssertionEvidence("Default off blocks only the new desktop client", `desktop=${String(start.state)}; Den=${String(denied.error)}; CLI=${cli.status}; plugin=${plugin.status}`, start.state === "unsupported" && cli.status === 200 && plugin.status === 200);
    await appUser.screenshot();
  });

  await step("the operator enables device sign-in and the remote user can cancel a pending request", async () => {
    await world.rollout(true);
    expect(await world.features()).toBe(true);
    const started = record(await desktop.run("auth.device-login.start", world.args));
    expect(started.deviceCode).toBeUndefined();
    expect(started.token).toBeUndefined();
    await desktop.run("auth.device-login.cancel");
    const cancelled = record(await desktop.run("auth.device-login.status"));
    expect(cancelled.state).not.toBe("pending");
    const auth = record(await desktop.run("auth.status"));
    expect(auth.user).toBeNull();
    await appUser.notSee({ text: "Choose your organization" });
    evidence.recordAssertionEvidence("Cancellation leaves the remote desktop signed out", `device=${String(cancelled.state)}; account=none; start exposes no device code or bearer`, auth.user === null && cancelled.state !== "pending");
  });

  await step("the approving member cannot approve without choosing a workspace and can deny the request", async () => {
    const started = record(await desktop.run("auth.device-login.start", world.args));
    userCode = text(started.userCode);
    const missingOrganization = await world.approveWithoutOrganization(userCode);
    expect(missingOrganization).toBe(400);
    await browser.navigate(text(started.verificationUriComplete));
    await browser.see({ testId: "device-desktop-consent-line" }, { timeoutMs: 90_000 });
    await browser.click({ role: "button", label: "Deny" });
    const denied = await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 45_000, label: "the remote desktop receives the denial", until: value => value.state === "denied",
    });
    const auth = record(await desktop.run("auth.status"));
    expect(auth.user).toBeNull();
    evidence.recordAssertionEvidence("A denied computer receives no account", `approval without workspace=${missingOrganization}; desktop=${String(denied.state)}; account=none`, denied.state === "denied" && auth.user === null);
    await browser.screenshot();
  });

  await step("the remote user runs the real terminal command and compares the public code in a separate browser", async () => {
    await world.shell.start();
    const output = await probe.eventually(() => world.shell.output(), {
      within: 60_000, label: "the terminal prints a public verification URL and user code", until: value => /^Code: /m.test(value),
    });
    const url = output.match(/^Open (https?:\/\/\S+)$/m)?.[1];
    userCode = output.match(/^Code: (\S+)$/m)?.[1] ?? "";
    if (!url || !userCode) throw new Error("The device-login command did not print its public approval instructions.");
    expect(new URL(url).origin).toBe(new URL(world.den.ref.webUrl).origin);
    expect(new URL(url).searchParams.has("device_code")).toBe(false);
    await browser.navigate(url);
    await browser.see({ testId: "device-desktop-consent-line" }, { timeoutMs: 90_000 });
    await browser.see({ text: userCode.replace(/^([^-]{4})([^-]{4})$/, "$1-$2") });
    await browser.see({ text: "Only approve if you started this in your own terminal and the code matches." });
    evidence.recordAssertionEvidence("The terminal and approving browser show the same public code", "real openwork-server command → public Den /device URL and matching user code; no device_code in URL", userCode.length > 0 && !new URL(url).searchParams.has("device_code"));
    await browser.screenshot();
  });

  await step("the member explicitly chooses workspace B rather than the browser's active workspace A", async () => {
    // A native select is driven with trusted keyboard input, never a state setter.
    await browser.click({ role: "combobox", label: "Organization" });
    await browser.press("Home");
    for (let index = 0; index < world.orgBIndex; index++) await browser.press("ArrowDown");
    await browser.press("Enter");
    await browser.see({ testId: "device-desktop-consent-line" }, { text: new RegExp(world.orgB.name) });
    await browser.click({ role: "button", label: "Approve" });
    await browser.see({ text: "Return to the OpenWork app on that computer." }, { timeoutMs: 30_000 });
    const approvedPage = await probe.on(world.web).text();
    evidence.recordAssertionEvidence("The approval names the chosen workspace", `browser started in ${world.orgA.name}; explicit approval=${world.orgB.name}`, approvedPage.includes(world.orgB.name));
    await browser.screenshot();
  });

  await step("after: the app adopts workspace B directly and attempts its existing runner registration", async () => {
    const signedIn = await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 90_000, label: "the remote desktop finishes durable sign-in", until: value => value.state === "signed_in",
    });
    expect(signedIn.email).toBe(world.email);
    expect(record(signedIn.org).id).toBe(world.orgB.id);
    const auth = await probe.eventually(async () => record(await desktop.run("auth.status")), {
      within: 60_000, label: "the app's normal auth provider sees its enrolled session", until: value => value.status === "signed_in",
    });
    expect(auth.status).toBe("signed_in");
    expect(record(auth.user).email).toBe(world.email);
    await appUser.notSee({ text: "Choose your organization" });
    const runner = await probe.eventually(() => world.runnerAttempted(), {
      within: 60_000, label: "the enrolled app requests its existing runner token", until: value => value,
    });
    evidence.recordAssertionEvidence("The chosen workspace is adopted without another chooser", `auth=${String(auth.status)}; active workspace=${world.orgB.name}; existing runner token route reached=${runner}`, runner);
    await appUser.screenshot();
  });

  await step("the command exits successfully without exposing the browser or desktop session", async () => {
    const exitCode = await probe.eventually(() => world.shell.exitCode(), {
      within: 30_000, label: "the terminal command exits after sign-in", until: value => value !== null,
    });
    expect(exitCode).toBe(0);
    const output = await world.shell.output();
    expect(output).toContain(`Signed in as ${world.email} in ${world.orgB.name}. Runner:`);
    expect(output).not.toMatch(/device_code|access_token|authToken|Bearer /i);
    const custody = await world.custody(output);
    expect(custody).toEqual({ tokenPresent: true, distinctBrowserSession: true, outputContainsToken: false, outputContainsBrowserToken: false, activeOrgId: world.orgB.id, logContainsBrowserToken: false, logContainsToken: false });
    evidence.recordAssertionEvidence("The desktop receives its own session, not a copy of the approving browser", `exit=${exitCode}; bearer present=true; distinct browser session=true; active workspace B=true; session in stdout/stderr=false`, exitCode === 0 && custody.distinctBrowserSession && !custody.outputContainsToken);
  });
});

test("a remote desktop cannot finish a pending sign-in after the operator kills the rollout", async ({ world, user, agent, probe, step, evidence }) => {
  const desktop = agent.on(world.app);
  const appUser = user.on(world.app);
  await step("before: the operator enables device sign-in and a fresh computer waits for approval", async () => {
    await appUser.see({ text: "Welcome to OpenWork" }, { timeoutMs: 180_000 });
    await world.rollout(true);
    const started = record(await desktop.run("auth.device-login.start", world.args));
    expect(started.userCode).toBeTypeOf("string");
    const pending = record(await desktop.run("auth.device-login.status"));
    expect(pending.state).toBe("pending");
    evidence.recordAssertionEvidence("An enabled deployment starts a pending device sign-in", `device=${String(pending.state)}; public user code present=true`, pending.state === "pending");
  });
  await step("the operator kills the rollout and the remote desktop stops polling", async () => {
    await world.rollout(true, true);
    const stopped = await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 45_000, label: "the server kill switch terminates pending device polling", until: value => value.state === "unsupported" || value.state === "failed" || value.state === "denied",
    });
    expect(await world.features()).toBe(false);
    await appUser.notSee({ text: "Choose your organization" });
    evidence.recordAssertionEvidence("The kill switch wins over the deployment rollout", `deployment rollout=on; kill=on; effective=off; desktop=${String(stopped.state)}`, stopped.state !== "pending");
  });
  await step("after: the computer remains signed out and cannot obtain a replacement code", async () => {
    const auth = record(await desktop.run("auth.status"));
    expect(auth.user).toBeNull();
    const rejected = await world.codeStatus();
    expect(rejected.error).toBe("invalid_client");
    await appUser.see({ text: "Welcome to OpenWork" });
    evidence.recordAssertionEvidence("A killed flow grants no account or new device code", `account=none; new code=${String(rejected.error)}`, auth.user === null && rejected.error === "invalid_client");
    await appUser.screenshot();
  });
});
