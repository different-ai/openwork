import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { opencodePluginSignIn } from "../worlds/opencode-plugin-sign-in.ts";
import { isEmulatedClientWidth } from "../worlds/library.ts";

const test = spec.world(opencodePluginSignIn, {
  timeout: 900_000,
  needs: { commands: ["pnpm", "node", "git"] },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a person signs OpenCode in from the browser despite one rate-limited token poll and lands back on OpenCode", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.web);
  const page = probe.on(world.web);
  const consent = `Only approve if you started this in your own terminal and the code matches. OpenWork - OpenCode Plugin will act as ${world.den.admin.email} in ${world.organizationName} until you sign out of it.`;

  await step("before: with the plugin sign-in switched off, OpenCode still signs in as the OpenWork CLI", async () => {
    await world.setPluginSignIn(false);
    const login = await world.startLogin("code");
    await person.navigate(login.verificationUrl);
    await person.see({ text: "Sign in OpenWork CLI?" }, { timeoutMs: 90_000 });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ role: "button", label: "Sign in OpenWork CLI" });
    const heading = await world.approvalHeading();
    expect(heading.text).toBe("Sign in OpenWork CLI.");
    expect(heading.fontSize).toBeGreaterThan(20);
    await person.screenshot();
    await person.click({ role: "button", label: "Deny" });
    await person.see({ text: /Sign-in denied/ });
    const result = await login.finished;
    const refused = result.status !== 0;
    evidence.recordAssertionEvidence(
      "Den falls back to the CLI client and a denied code gives OpenCode nothing",
      `page: "Sign in OpenWork CLI?"; unchanged "${heading.text}" headline at ${heading.fontSize}px; opencode auth login exit ${result.status}`,
      refused,
    );
    expect(refused).toBe(true);
  });

  const login = await (async () => {
    await world.setPluginSignIn(true);
    return world.startLogin("browser", { throttleTokenPoll: true });
  })();

  await step("the browser names OpenCode and shows the code from the terminal", async () => {
    const url = new URL(login.verificationUrl);
    expect(url.pathname).toBe("/device");
    expect(url.searchParams.get("return_to")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openwork\/callback$/);
    await person.navigate(login.verificationUrl);
    await person.see({ role: "heading", label: "Sign in OpenWork - OpenCode Plugin?" }, { timeoutMs: 90_000 });
    await person.see({ role: "heading", label: "Approve this sign-in" });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ text: "$ opencode auth login openwork" });
    await person.see({ text: world.den.admin.email });
    await person.see({ testId: "device-consent-line", text: consent });
    await person.see({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ role: "button", label: "Deny" });
    const heading = await world.approvalHeading();
    expect(isEmulatedClientWidth(heading.viewportWidth, 1280)).toBe(true);
    expect(heading.viewportHeight).toBe(900);
    expect(heading.text).toBe("Approve this sign-in");
    expect(heading.fontSize).toBeGreaterThan(0);
    expect(heading.fontSize).toBeLessThanOrEqual(20);
    expect(heading.lineHeight).toBeGreaterThan(0);
    expect(heading.height).toBeGreaterThan(0);
    expect(heading.height).toBeLessThanOrEqual(2 * heading.lineHeight + 1);
    evidence.recordAssertionEvidence(
      "The compact heading leaves the full OpenCode identity, matching code and consent intact",
      `1280×900; "${heading.text}" at ${heading.fontSize}px, height ${heading.height}px / line height ${heading.lineHeight}px; panel and action name OpenWork - OpenCode Plugin; terminal code ${login.userCode}; consent names ${world.den.admin.email}, ${world.organizationName}, own-terminal/code risk and sign-out; return page on a loopback port`,
      true,
    );
    await person.screenshot();
  });

  await step("after: on a phone, the short heading still leaves the full OpenCode consent and both choices readable", async () => {
    await person.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await person.see({ role: "heading", label: "Approve this sign-in" });
    await person.see({ role: "heading", label: "Sign in OpenWork - OpenCode Plugin?" });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ testId: "device-consent-line", text: consent });
    await person.see({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ role: "button", label: "Deny" });
    await person.hover({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.hover({ role: "button", label: "Deny" });
    // Show the whole undecided consent from the top, not a cropped action-only capture.
    await person.see({ role: "heading", label: "Approve this sign-in" });
    const heading = await world.approvalHeading();
    const layout = await page.dom('[data-testid="setup-frame"] h1, [data-testid="device-approval"] h2, [data-testid="device-consent-line"], [data-testid="device-approval"] button');
    expect(isEmulatedClientWidth(heading.viewportWidth, 390)).toBe(true);
    expect(heading.viewportHeight).toBe(844);
    expect(heading.text).toBe("Approve this sign-in");
    expect(heading.fontSize).toBeGreaterThan(0);
    expect(heading.fontSize).toBeLessThanOrEqual(20);
    expect(heading.lineHeight).toBeGreaterThan(0);
    expect(heading.height).toBeGreaterThan(0);
    expect(heading.height).toBeLessThanOrEqual(2 * heading.lineHeight + 1);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    for (const element of layout.elements) {
      expect(element.rect.width).toBeGreaterThan(0);
      expect(element.rect.left).toBeGreaterThanOrEqual(0);
      expect(element.rect.right).toBeLessThanOrEqual(layout.viewportWidth);
      expect(element.rect.top).toBeGreaterThanOrEqual(0);
      expect(element.rect.bottom).toBeLessThanOrEqual(844);
    }
    evidence.recordAssertionEvidence(
      "At phone width the heading uses at most two compact lines without hiding consent or Deny",
      `390×844; "${heading.text}" at ${heading.fontSize}px, height ${heading.height}px / line height ${heading.lineHeight}px; document ${layout.documentWidth}px; panel, code ${login.userCode}, full action/data/risk consent and exact OpenCode sign-in action remain; both decisions pass the real pointer hit test`,
      true,
    );
    await person.screenshot();
  });

  await step("when one token poll is rate-limited, the same sign-in keeps waiting for browser approval", async () => {
    await person.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    const fault = await probe.eventually(() => world.tokenPollFault(), {
      within: 60_000,
      intervalMs: 200,
      label: "one plain HTTP 429 followed by a retry before approval",
      until: (value) => value.injected === 1 && value.retriedPolls > 0,
    });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    const survived = fault.http429s === 1 && fault.authorizations === 1;
    evidence.recordAssertionEvidence(
      "One plain HTTP throttle does not restart or end the person's sign-in",
      `POST /api/auth/device/token: ${fault.http429s} HTTP 429, Retry-After: 1, body {"error":"rate_limited"} (not slow_down); ${fault.retriedPolls} subsequent polls; ${fault.authorizations} device authorization; ${login.userCode} still awaiting approval`,
      survived,
    );
    expect(fault.http429s).toBe(1);
    expect(fault.authorizations).toBe(1);
    await person.screenshot();
  });

  await step("after: approving the same code sends the browser back to OpenCode, which is now signed in", async () => {
    await person.click({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ text: "OpenCode is connected to OpenWork" }, { timeoutMs: 30_000 });
    await person.see({ text: "You can close this tab and go back to OpenCode." });
    await person.screenshot();
    const result = await login.finished;
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("Connected to OpenWork Cloud");
    const accounts = await world.run(["auth", "list"]);
    const listed = accounts.stdout.includes(world.den.admin.email);
    const fault = await world.tokenPollFault();
    const recovered = listed && fault.injected === 1 && fault.http429s === 1 && fault.authorizations === 1;
    evidence.recordAssertionEvidence(
      "OpenCode stores the approved account without restarting after the single throttle",
      `opencode auth login exit 0 ("Connected to OpenWork Cloud"); opencode auth list shows ${world.den.admin.email}: ${listed}; ${fault.injected} injected throttle, ${fault.http429s} total HTTP 429, ${fault.authorizations} device authorization`,
      recovered,
    );
    expect(recovered).toBe(true);
  });

  await step("after: OpenCode loads OpenWork's MCP gateway with that sign-in", async () => {
    let servers = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      servers = (await world.run(["mcp", "list"])).stdout;
      if (/openwork-cloud[\s\S]*connected/i.test(servers)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const connected = /openwork-cloud[\s\S]*connected/i.test(servers);
    evidence.recordAssertionEvidence(
      "The openwork-cloud MCP server connects through Den's MCP gateway",
      servers.split("\n").filter((line) => line.includes("openwork")).join(" | ") || servers.slice(0, 300),
      connected,
    );
    expect(connected).toBe(true);
  });

  await step("a return address that is not on this machine is ignored", async () => {
    const tampered = await world.startLogin("code");
    const url = new URL(tampered.verificationUrl);
    url.searchParams.set("return_to", "https://example.com/openwork/callback");
    await person.navigate(url.toString());
    await person.see({ testId: "device-user-code", text: tampered.userCode }, { timeoutMs: 60_000 });
    await person.click({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ text: "OpenWork - OpenCode Plugin is signed in" }, { timeoutMs: 30_000 });
    await person.see({ text: "Return to OpenCode." });
    await person.screenshot();
    const result = await tampered.finished;
    evidence.recordAssertionEvidence(
      "Den keeps the person on its own page instead of following an outside address",
      `return_to=https://example.com/… → stayed on Den ("Return to OpenCode."); opencode auth login exit ${result.status}`,
      result.status === 0,
    );
    expect(result.status).toBe(0);
  });
});
