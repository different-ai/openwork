import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { bareFirstRunWorld } from "../worlds/first-run.ts";

const test = spec.world(bareFirstRunWorld);
const inviteUrl = "http://localhost:59991/join-org?invite=inv_demo123";

test("the welcome join field takes a server URL or web invite and points the app at that organization", async ({ world, user, probe, step }) => {
  // TODO(primitive): read the persisted desktop bootstrap configuration.
  const readBootstrapBaseUrl = () => probe.eval(
    `window.__OPENWORK_ELECTRON__.invokeDesktop("getDesktopBootstrapConfig").then((config) => config.baseUrl)`,
    { awaitPromise: true },
  );
  await step("Welcome offers three doors", async () => {
    await user.see({ text: "Welcome to OpenWork" });
    await user.see("Sign in to OpenWork Cloud");
    await user.see("Use Without Cloud");
    await user.see({ text: "Join your organization" });
    await user.see({ text: "Paste your invite link, install link, or server URL" });
    await user.notSee({ text: /Using OpenWork on-premises\?/ });
    await user.looks([
      "The Welcome to OpenWork heading is visible",
      "Sign in to OpenWork Cloud and Use Without Cloud are offered",
      "Join your organization says to paste an invite link, install link, or server URL",
      "The page does not say Using OpenWork on-premises",
    ]);
  });

  await user.click({ text: /Join your organization/ });
  const joinInput: Parameters<typeof user.type>[0] = { role: "textbox", label: /invite link|server url|sign-in code/i };

  await step("A server URL becomes the control plane", async () => {
    await user.type(joinInput, "https://openwork.acme.test");
    await user.click("Connect");
    await user.see({ text: /Connected to openwork\.acme\.test\. Sign in to continue\./ }, { timeoutMs: 20_000 });
    expect(await readBootstrapBaseUrl()).toBe("https://openwork.acme.test");
    await user.looks([
      "The join dialog field label mentions invite link, install link, or server URL",
      "The dialog confirms it connected to openwork.acme.test",
    ]);
  });

  await step("A web invite requests trust before browser handoff", async () => {
    await user.type(joinInput, inviteUrl, { replace: true });
    await user.click("Connect");
    await user.see({ text: /Trust this organization server\?/ }, { timeoutMs: 20_000 });
    expect(await readBootstrapBaseUrl()).toBe("https://openwork.acme.test");
    await user.click("Trust and open invite");
    await user.see({ text: /Your invite opened in the browser/ }, { timeoutMs: 20_000 });
    expect(await readBootstrapBaseUrl()).toBe("http://localhost:59991");
    if (world.capture) expect(await world.capture.waitForUrl((url) => url === inviteUrl, { timeoutMs: 20_000 })).toBe(inviteUrl);
    await user.looks(["The dialog says the invite opened in the browser and to finish joining there"]);
  });
});
