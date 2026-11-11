import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record, text } from "../worlds/org-invite.ts";
import { remoteDesktopDeviceLogin } from "../worlds/remote-desktop-device-login.ts";

const test = spec.world(remoteDesktopDeviceLogin, {
  resources: {
    surfaces: ["desktop", "web"], services: ["den"],
    nativeReason: "The real shell command calls Electron's authenticated loopback control bridge; device polling and durable enrollment belong to that native app, not a browser substitute.",
  },
  needs: { placement: "daytona", env: ["OPENWORK_EVAL_ELECTRON_BINARY"] },
  timeout: 900_000,
});

test("a remote desktop signs in with its own session to the organization chosen on another computer", async ({ world, user, agent, probe, step, evidence }) => {
  const desktop = agent.on(world.app);
  const appUser = user.on(world.app);
  const browser = user.on(world.web);
  let userCode = "";

  await step("before: device sign-in is off by default while existing terminal clients remain available", async () => {
    await appUser.see({ text: "Sync with OpenWork Cloud" }, { timeoutMs: 180_000 });
    const origin = await world.packagedOrigin();
    expect(origin.protocol).toBe("file:");
    expect(origin.path).toContain("/resources/app-dist/index.html");
    expect(new URL(world.den.ref.webUrl).protocol).toBe("https:");
    expect(world.defaultEnabled).toBe(false);
    expect(await world.features()).toBe(false);
    expect(await world.shell.discoveryCustody()).toEqual({ mode: 0o600, ownedByCurrentUser: true, regularFile: true, privateAncestor: false });
    const boundaries = await world.offBoundaries();
    expect(boundaries.decisionStatus).toBe(403);
    expect(boundaries.tokenStatus).not.toBe(200);
    expect(boundaries.sessionIssued).toBe(false);
    const start = record(await desktop.run("auth.device-login.start", world.args));
    expect(start.state).toBe("unsupported");
    const denied = await world.codeStatus();
    expect(denied.error).toBe("invalid_client");
    const cli = await world.codeStatus("openwork-cli");
    const plugin = await world.codeStatus("openwork-opencode-plugin");
    expect(cli.status).toBe(200);
    expect(plugin.status).toBe(200);
    evidence.recordAssertionEvidence("Default off blocks only the new desktop client", `packaged file renderer; discovery=0600/current uid/no private ancestor; desktop=${String(start.state)}; Den=${String(denied.error)}; decision=${boundaries.decisionStatus}; token=${boundaries.tokenStatus}/no session; CLI=${cli.status}; plugin=${plugin.status}`, start.state === "unsupported" && cli.status === 200 && plugin.status === 200);
    await appUser.screenshot();
  });

  await step("the operator enables device sign-in and the remote user can cancel a pending request", async () => {
    await world.rollout(true);
    expect(await world.features()).toBe(true);
    await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 90_000, label: "the configured deployment enables device sign-in", until: value => value.state !== "unsupported",
    });
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

  await step("the approving member cannot approve without choosing an organization and can deny the request", async () => {
    const started = record(await desktop.run("auth.device-login.start", world.args));
    userCode = text(started.userCode);
    const missingOrganization = await world.approveWithoutOrganization(userCode);
    expect(missingOrganization).toBe(400);
    await browser.navigate(text(started.verificationUriComplete));
    await browser.see({ testId: "device-desktop-consent-line" }, { timeoutMs: 90_000 });
    await browser.see({ text: "Choose an organization" });
    expect((await probe.on(world.web).dom('[data-testid="device-approve"][disabled]')).elements).toHaveLength(1);
    await browser.click({ role: "button", label: "Deny" });
    const denied = await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 45_000, label: "the remote desktop receives the denial", until: value => value.state === "denied",
    });
    const auth = record(await desktop.run("auth.status"));
    expect(auth.user).toBeNull();
    evidence.recordAssertionEvidence("A denied computer receives no account", `approval without organization=${missingOrganization}; desktop=${String(denied.state)}; account=none`, denied.state === "denied" && auth.user === null);
    await browser.screenshot();
  });

  await step("the remote user runs the real terminal command and compares the public code in a separate browser", async () => {
    await world.shell.start();
    const output = await probe.eventually(() => world.shell.output(), {
      within: 60_000, label: "the terminal prints a public verification URL and user code", until: value => /Then check the code [A-Z0-9]{4}-[A-Z0-9]{4} and choose the organization\./.test(value),
    });
    const url = output.match(/^(https?:\/\/\S+)$/m)?.[1];
    userCode = output.match(/Then check the code ([A-Z0-9]{4}-[A-Z0-9]{4}) and choose the organization\./)?.[1] ?? "";
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

  await step("the member explicitly chooses organization B rather than the browser's active organization A", async () => {
    await browser.see({ text: "Choose an organization" });
    expect((await probe.on(world.web).dom('[data-testid="device-approve"][disabled]')).elements).toHaveLength(1);
    // The shared organization selector is a button/listbox, not an HTML combobox.
    await browser.click({ role: "button", label: "Organization" });
    await browser.click({ role: "option", label: world.orgB.name });
    await browser.see({ testId: "device-desktop-consent-line" }, { text: new RegExp(world.orgB.name) });
    expect((await probe.on(world.web).dom('[data-testid="device-approve"]:not([disabled])')).elements).toHaveLength(1);
    await browser.click({ role: "button", label: "Approve" });
    await browser.see({ text: "Return to the OpenWork app on that computer." }, { timeoutMs: 30_000 });
    const approvedPage = await probe.on(world.web).text();
    evidence.recordAssertionEvidence("The approval names the chosen organization", `browser started in ${world.orgA.name}; explicit approval=${world.orgB.name}`, approvedPage.includes(world.orgB.name));
    await browser.screenshot();
  });

  await step("after: the app adopts organization B directly and attempts its existing runner registration", async () => {
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
    expect(world.baselineA).toEqual([]);
    expect(world.baselineB).toEqual([]);
    const runner = await probe.eventually(() => world.runnerRegistration(), {
      within: 90_000, label: "the real session runner is registered in B and absent in A", until: value => value.addedB.length === 1 && value.addedB[0]?.registered === true && value.addedB[0]?.online === true,
    });
    expect(runner.sameIdentityAbsentInA).toBe(true);
    expect(runner.sessionOnlyTokenMinted).toBe(true);
    expect(runner.inA).toEqual([]);
    evidence.recordAssertionEvidence("The chosen organization has this registered computer and the other organization does not", `auth=${String(auth.status)}; B target=${runner.addedB[0]?.computerId}; registered=true; online=true; same identity in A=false`, runner.sameIdentityAbsentInA && runner.addedB.length === 1);
    await appUser.screenshot();
  });

  await step("the command exits successfully without exposing the browser or desktop session", async () => {
    const exitCode = await probe.eventually(() => world.shell.exitCode(), {
      within: 30_000, label: "the terminal command exits after sign-in", until: value => value !== null,
    });
    expect(exitCode).toBe(0);
    const output = await world.shell.output();
    expect(output).toContain(`Signed in as ${world.email} in ${world.orgB.name}.`);
    expect(output).toContain("Waiting for approval…");
    expect(output).not.toContain("Runner:");
    expect(output).not.toMatch(/device_code|access_token|authToken|Bearer /i);
    const custody = await world.custody(output);
    expect(custody).toEqual({ tokenPresent: true, distinctBrowserSession: true, outputContainsToken: false, outputContainsBrowserToken: false, activeOrgId: world.orgB.id, logContainsBrowserToken: false, logContainsToken: false });
    evidence.recordAssertionEvidence("The desktop receives its own session, not a copy of the approving browser", `exit=${exitCode}; bearer present=true; distinct browser session=true; active organization B=true; session in stdout/stderr=false`, exitCode === 0 && custody.distinctBrowserSession && !custody.outputContainsToken);
  });
});

test("a remote desktop cannot finish a pending sign-in after the operator kills the rollout", async ({ world, user, agent, probe, step, evidence }) => {
  const desktop = agent.on(world.app);
  const appUser = user.on(world.app);
  await step("before: the operator enables device sign-in and a fresh computer waits for approval", async () => {
    await appUser.see({ text: "Sync with OpenWork Cloud" }, { timeoutMs: 180_000 });
    await world.rollout(true);
    await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 90_000, label: "the configured deployment enables device sign-in", until: value => value.state !== "unsupported",
    });
    const started = record(await desktop.run("auth.device-login.start", world.faultArgs));
    expect(started.userCode).toBeTypeOf("string");
    const pending = record(await desktop.run("auth.device-login.status"));
    expect(pending.state).toBe("pending");
    evidence.recordAssertionEvidence("An enabled deployment starts a pending device sign-in", `device=${String(pending.state)}; public user code present=true`, pending.state === "pending");
  });
  await step("the operator kills the rollout and the remote desktop stops polling", async () => {
    await probe.eventually(() => world.traffic(), {
      within: 30_000, label: "the pending flow actually reaches the token endpoint", until: value => value.tokenArrivals.length > 0,
    });
    expect(await world.enableOrganizationOverride()).toBe(200);
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
    await appUser.see({ text: "Sync with OpenWork Cloud" });
    const finished = (await world.traffic()).tokens.length;
    const observedAt = Date.now();
    const stable = await probe.eventually(async () => ({ elapsed: Date.now() - observedAt, count: (await world.traffic()).tokens.length }), {
      within: 15_000, intervalMs: 1_000, label: "a terminal flow makes no more token requests", until: value => value.elapsed >= 7_000,
    });
    expect(stable.count).toBe(finished);
    const sessions = await world.sessionCount();
    expect(sessions).toBe(world.baselineSessionCount);
    evidence.recordAssertionEvidence("A killed flow grants no account, new Den session or replacement code", `account=none; Den sessions before/after=${world.baselineSessionCount}/${sessions}; new code=${String(rejected.error)}; additional polls over ${stable.elapsed}ms=${stable.count - finished}`, auth.user === null && sessions === world.baselineSessionCount && rejected.error === "invalid_client" && stable.count === finished);
    await appUser.screenshot();
  });
});

test("a remote desktop respects expiry and server backoff without replacing the pending code", async ({ world, user, agent, probe, step, evidence }) => {
  const desktop = agent.on(world.app);
  const appUser = user.on(world.app);
  await step("before: the packaged computer is signed out and device sign-in is enabled", async () => {
    await appUser.see({ text: "Sync with OpenWork Cloud" }, { timeoutMs: 180_000 });
    await world.rollout(true);
    const status = await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 90_000, label: "the configured deployment enables device sign-in", until: value => value.state !== "unsupported",
    });
    const auth = record(await desktop.run("auth.status"));
    expect(auth.user).toBeNull();
    evidence.recordAssertionEvidence("A fresh packaged desktop has no account", `account=none; device control=${String(status.state)}`, auth.user === null);
  });
  await step("an expired response ends the real desktop's pending sign-in without an account", async () => {
    await world.tokenFault("expired_token");
    const started = record(await desktop.run("auth.device-login.start", world.faultArgs));
    expect(started.userCode).toBeTypeOf("string");
    const expired = await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 45_000, label: "the packaged desktop stops on expired_token", until: value => value.state === "expired",
    });
    const auth = record(await desktop.run("auth.status"));
    expect(auth.user).toBeNull();
    const traffic = await world.traffic();
    expect(traffic.tokens.some(request => request.faulted && request.status === 400)).toBe(true);
    await appUser.see({ text: "Sync with OpenWork Cloud" });
    evidence.recordAssertionEvidence("Expired sign-in stops without enrolling the computer", `real start; token-boundary expired_token; desktop=${String(expired.state)}; account=none`, expired.state === "expired" && auth.user === null);
  });
  await step("slow down and a rate limit delay the same code instead of starting another sign-in", async () => {
    const before = await world.traffic();
    await world.tokenFault("slow_down");
    await world.tokenFault("authorization_pending", 429, { "Retry-After": "17" });
    const started = record(await desktop.run("auth.device-login.start", world.faultArgs));
    expect(started.userCode).toBeTypeOf("string");
    const traffic = await probe.eventually(() => world.traffic(), {
      within: 75_000, intervalMs: 1_000, label: "three token polls show both backoff intervals", until: value => value.tokens.length - before.tokens.length >= 3,
    });
    const polls = traffic.tokens.slice(before.tokens.length);
    const first = polls[0], second = polls[1], third = polls[2];
    if (!first || !second || !third) throw new Error("The token fault witness did not observe three polls.");
    const slowDownGap = second.at - first.at;
    const rateLimitGap = third.at - second.at;
    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
    expect(slowDownGap).toBeGreaterThanOrEqual(9_500);
    expect(rateLimitGap).toBeGreaterThanOrEqual(16_500);
    expect(rateLimitGap).toBeLessThan(30_000);
    expect(traffic.codes.length - before.codes.length).toBe(1);
    expect(record(await desktop.run("auth.device-login.status")).state).toBe("pending");
    await desktop.run("auth.device-login.cancel");
    await appUser.see({ text: "Sync with OpenWork Cloud" });
    evidence.recordAssertionEvidence("Backoff and Retry-After preserve the original pending sign-in", `slow_down gap=${slowDownGap}ms; 429 Retry-After=17s gap=${rateLimitGap}ms (longer than default 15s); code starts=1; cancelled while signed out`, slowDownGap >= 9_500 && rateLimitGap >= 16_500 && rateLimitGap < 30_000 && traffic.codes.length - before.codes.length === 1);
    await appUser.screenshot();
  });
});

test("approval does not grant a remote computer access after the operator kills redemption", async ({ world, user, agent, probe, step, evidence }) => {
  const desktop = agent.on(world.app);
  const appUser = user.on(world.app);
  const browser = user.on(world.web);
  let tokenArrivedAt = 0;
  let approvalUrl = "";
  await step("before: a fresh packaged computer waits for a browser decision with its next token request delayed", async () => {
    await appUser.see({ text: "Sync with OpenWork Cloud" }, { timeoutMs: 180_000 });
    await world.rollout(true);
    await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 90_000, label: "the configured deployment enables device sign-in", until: value => value.state !== "unsupported",
    });
    await world.holdNextToken();
    const started = record(await desktop.run("auth.device-login.start", world.faultArgs));
    approvalUrl = text(started.verificationUriComplete);
    const held = await probe.eventually(() => world.traffic(), {
      within: 30_000, intervalMs: 250, label: "a real token request arrives at the nine-second network hold", until: value => value.tokenArrivals.some(request => request.faulted),
    });
    expect(held.tokenArrivals.length).toBe(1);
    const arrival = held.tokenArrivals[0];
    if (!arrival?.faulted) throw new Error("The token hold must identify its actual arrival.");
    tokenArrivedAt = arrival.at;
    expect(held.tokens).toEqual([]);
    expect(record(await desktop.run("auth.device-login.status")).state).toBe("pending");
    evidence.recordAssertionEvidence("The desktop's real token request has arrived but has not completed", "real Den code issued; token request arrival=1; responses=0; network delay=9000ms", held.tokenArrivals.length === 1 && held.tokens.length === 0);
  });
  await step("the member approves but the operator kills access before the delayed redemption can arrive", async () => {
    await browser.navigate(approvalUrl);
    await browser.see({ testId: "device-desktop-consent-line" }, { timeoutMs: 30_000 });
    await browser.click({ role: "button", label: "Organization" });
    await browser.click({ role: "option", label: world.orgB.name });
    await browser.click({ role: "button", label: "Approve" });
    await browser.see({ text: "Return to the OpenWork app on that computer." }, { timeoutMs: 15_000 });
    // A witness, not a hopeful race: fail if cold page hydration consumed the
    // hold window. No test setter or interception of a successful token exists.
    expect(Date.now() - tokenArrivedAt).toBeLessThan(9_000);
    expect(record(await desktop.run("auth.device-login.status")).state).toBe("pending");
    await world.rollout(true, true);
    expect(await world.features()).toBe(false);
    const elapsed = Date.now() - tokenArrivedAt;
    const killedBeforeRedemption = elapsed < 9_000;
    expect(killedBeforeRedemption).toBe(true);
    evidence.recordAssertionEvidence("The kill switch is set after browser approval and before redemption", `browser approved; desktop still pending; kill enabled ${elapsed}ms after held request arrival; token delay=9000ms`, killedBeforeRedemption);
    await browser.screenshot();
  });
  await step("after: the approved computer still has no account or newly issued Den session", async () => {
    const terminal = await probe.eventually(async () => record(await desktop.run("auth.device-login.status")), {
      within: 45_000, label: "the approved flow stops when redemption is killed", until: value => value.state === "unsupported" || value.state === "denied" || value.state === "failed",
    });
    const auth = record(await desktop.run("auth.status"));
    expect(auth.user).toBeNull();
    await probe.eventually(() => Date.now() - tokenArrivedAt, {
      within: 30_000, intervalMs: 500, label: "the held token request's response and cancellation window has elapsed", until: elapsed => elapsed >= 17_000,
    });
    const traffic = await world.traffic();
    expect(traffic.tokenArrivals.length).toBeGreaterThanOrEqual(1);
    expect(traffic.tokens.every(request => request.status !== 200)).toBe(true);
    const sessions = await world.sessionCount();
    expect(sessions).toBe(world.baselineSessionCount);
    await appUser.see({ text: "Sync with OpenWork Cloud" });
    evidence.recordAssertionEvidence("Approval cannot bypass a killed redemption", `desktop=${String(terminal.state)}; held token request arrived=true; account=none; Den sessions before/after=${world.baselineSessionCount}/${sessions}; successful token responses=0`, auth.user === null && sessions === world.baselineSessionCount && traffic.tokenArrivals.length > 0 && traffic.tokens.every(request => request.status !== 200));
    await appUser.screenshot();
  });
});

test("a member can still use the existing sign-in handoff when device sign-in is off", async ({ world, user, agent, probe, step, evidence }) => {
  const desktop = agent.on(world.app);
  const appUser = user.on(world.app);
  await step("before: the packaged app is signed out and the new device sign-in is unavailable", async () => {
    await appUser.see({ text: "Sync with OpenWork Cloud" }, { timeoutMs: 180_000 });
    expect(await world.features()).toBe(false);
    const disabled = record(await desktop.run("auth.device-login.start", world.args));
    expect(disabled.state).toBe("unsupported");
    expect(record(await desktop.run("auth.status")).user).toBeNull();
    evidence.recordAssertionEvidence("Disabling device sign-in leaves a fresh app signed out", `device=${String(disabled.state)}; account=none`, disabled.state === "unsupported");
    await appUser.screenshot();
  });
  await step("the member uses a real grant through the unchanged sign-in handoff action", async () => {
    // This proves the existing grant protocol/control entry point, not OS
    // openwork:// dispatch. No invite UI, dev setter or synthetic grant is used.
    const exchanged = await world.exchangeExistingHandoff();
    expect(exchanged.email).toBe(world.email);
    const auth = await probe.eventually(async () => record(await desktop.run("auth.status")), {
      within: 90_000, label: "the old handoff signs the packaged desktop in", until: value => value.status === "signed_in",
    });
    expect(record(auth.user).email).toBe(world.email);
    await appUser.notSee({ text: "Choose your organization" });
    const custody = await world.custody("");
    expect(custody.tokenPresent).toBe(true);
    expect(custody.distinctBrowserSession).toBe(false);
    expect(custody.activeOrgId).toBe(world.orgA.id);
    evidence.recordAssertionEvidence("The legacy handoff keeps its original session and organization", `auth=${String(auth.status)}; chosen organization=${world.orgA.name}; original browser session reused=true; no second chooser`, auth.status === "signed_in" && !custody.distinctBrowserSession && custody.activeOrgId === world.orgA.id);
    await appUser.screenshot();
  });
  await step("after: a disabled device start cannot replace the working handoff enrollment", async () => {
    const disabled = record(await desktop.run("auth.device-login.start", world.args));
    expect(disabled.state).toBe("unsupported");
    const auth = record(await desktop.run("auth.status"));
    expect(auth.status).toBe("signed_in");
    expect(record(auth.user).email).toBe(world.email);
    const custody = await world.custody("");
    expect(custody.distinctBrowserSession).toBe(false);
    expect(custody.activeOrgId).toBe(world.orgA.id);
    expect(custody.logContainsToken).toBe(false);
    expect(custody.logContainsBrowserToken).toBe(false);
    await appUser.notSee({ text: "Choose your organization" });
    evidence.recordAssertionEvidence("The new flag does not supersede or gate the existing handoff", `device=${String(disabled.state)}; auth=${String(auth.status)}; original session and organization A unchanged=true; bearer in process log=false`, disabled.state === "unsupported" && auth.status === "signed_in" && !custody.distinctBrowserSession && custody.activeOrgId === world.orgA.id && !custody.logContainsToken);
    await appUser.screenshot();
  });
});
