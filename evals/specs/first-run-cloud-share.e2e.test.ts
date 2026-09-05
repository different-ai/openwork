import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { firstRunCloudShareWorld } from "../worlds/first-run.ts";

const test = spec.world(firstRunCloudShareWorld);

test("first run signs in through the browser, then shares a skill with a colleague via a marketplace", async ({ world, user, agent, probe, step }) => {
  const appUser = user.on(world.app);
  const webUser = user.on(world.web);
  const appProbe = probe.on(world.app);
  const webProbe = probe.on(world.web);

  await step("The fresh app offers cloud sign-in", async () => {
    await appUser.see("Sign in to OpenWork Cloud");
    await appUser.notSee({ text: /something went wrong/i });
    await appUser.looks([
      "A fresh OpenWork app is visible offering to sign in to OpenWork Cloud",
      "No error or 'Something went wrong' message is visible",
    ]);
  });

  await step("Cloud sign-in hands off to the browser", async () => {
    await appUser.click("Sign in to OpenWork Cloud");
    await appUser.notSee({ testId: "welcome-team-signin" }, { timeoutMs: 30_000 });
    expect(await appProbe.hash()).not.toBe("#/welcome");
    const handoffUrl = new URL(world.den.ref.webUrl);
    handoffUrl.searchParams.set("mode", "sign-in");
    handoffUrl.searchParams.set("desktopAuth", "1");
    handoffUrl.searchParams.set("desktopScheme", "openwork");
    await webUser.navigate(handoffUrl.toString());
    await webUser.see({ role: "textbox", label: /email/i }, { timeoutMs: 90_000 });
  });

  await step("The browser signs in with the cloud account", async () => {
    await webUser.type({ role: "textbox", label: /email/i }, world.den.admin.email, { replace: true });
    await webUser.click({ role: "button", text: /^next$/i });
    await webUser.see({ role: "textbox", label: /password/i }, { timeoutMs: 60_000 });
    await webUser.type({ role: "textbox", label: /password/i }, world.den.admin.password, { replace: true });
    await webUser.click({ role: "button", text: /^sign in$/i });
    await webUser.see({ text: /you(?:'|’)re signed in|open openwork/i }, { timeoutMs: 120_000 });
    await webUser.notSee({ text: /invalid credentials|something went wrong/i });
    await webUser.looks([
      "A browser page shows an OpenWork Cloud sign-in result, not a sign-in form error",
      "No 'invalid credentials' or error banner is visible",
    ]);
  });

  await step("The browser-issued grant returns to the app", async () => {
    // TODO(primitive): read the browser-issued desktop handoff URL.
    const deepLink = await probe.eventually(
      () => webProbe.eval(`(() => {
        const input = [...document.querySelectorAll("input")].find((candidate) => candidate.value.startsWith("openwork://") && candidate.value.includes("grant="));
        if (input) return input.value;
        return document.querySelector('a[href^="openwork://"]')?.getAttribute("href") ?? "";
      })()`),
      { within: 120_000, label: "browser-issued desktop handoff URL", until: (value) => typeof value === "string" && value.startsWith("openwork://") },
    );
    if (typeof deepLink !== "string") throw new Error("The browser-issued handoff URL was not a string.");
    const handoff = new URL(deepLink);
    const grant = handoff.searchParams.get("grant");
    expect(grant, `unexpected deep link: ${deepLink}`).toBeTruthy();
    await agent.on(world.app).run("auth.exchange-grant", { grant, baseUrl: world.den.ref.webUrl });
    await appUser.see({ text: world.den.admin.email }, { timeoutMs: 180_000 });
    await appUser.notSee({ text: /sign-in failure|something went wrong/i });
    await appUser.looks([
      "The app is back in focus and no longer offers a bare Sign in to OpenWork Cloud as the only action",
      "No sign-in failure message is visible",
    ]);
  });

  await step("The colleague can see the shared skill", async () => {
    const { plugin, skillName, visible } = await world.shareSkill();
    expect(visible.pluginNames).toContain(plugin.name);
    expect(visible.skillNames.some((name) => name.includes(skillName))).toBe(true);
  });

  await step("The app shows its extension library", async () => {
    await agent.on(world.app).run("route.extensions.skills");
    await appUser.see({ text: /library|extensions|skills|connections/i }, { timeoutMs: 60_000 });
    await appUser.notSee({ text: /something went wrong/i });
    await appUser.looks([
      "An OpenWork surface listing extensions, skills or connections is visible",
      "No 'Something went wrong' crash message is visible",
    ]);
  });
});
