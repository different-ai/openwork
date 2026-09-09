import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { addInitScript, browserScript } from "@openwork/cdp";
import { clickText } from "@openwork/behaviors";
import { firstRunCloudShareWorld } from "../worlds/first-run.ts";

const test = spec.world(firstRunCloudShareWorld);

test("first run signs in through the browser, then shares a skill with a colleague via a marketplace", async ({ world, user, agent, probe, evidence, step }) => {
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

  await step("Already-installed Cloud users return through the same instance's auth route", async () => {
    // Control installation metadata only. Session hydration, navigation and grant
    // generation use the real Den, including its existing browser session.
    await using configWitness = await addInitScript(world.web.client, browserScript((webUrl, apiUrl) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname !== "/v1/install-config" && url.pathname !== "/v1/me/install-config") {
          return originalFetch(input, init);
        }
        return Response.json({
          appName: "OpenWork", clientName: "Install Journey", requireSignin: true,
          logoUrl: null, iconUrl: null, desktopVersion: "0.18.0", distribution: "cloud",
          // A session-backed local/preview install must not jump to a configured hosted default.
          webUrl: url.searchParams.has("token") ? `${webUrl}/ignored-config-path` : "https://app.openworklabs.com",
          apiUrl,
        });
      };
    }, [world.den.ref.webUrl, world.den.ref.apiUrl]));
    const origin = new URL(world.den.ref.webUrl).origin;
    const authUrl = `${origin}/?mode=sign-in&desktopAuth=1&desktopScheme=openwork`;
    const installSource = new URL(origin);
    // Local Den trusts both aliases. A token-backed install on the other alias
    // must return to the configured instance, not the install page's origin.
    if (installSource.hostname === "127.0.0.1") installSource.hostname = "localhost";
    const grants = new Set<string>();
    for (const installUrl of [`${origin}/install`, `${installSource.origin}/install?token=synthetic-install-token&step=3`]) {
      await webUser.navigate(installUrl);
      await webUser.see({ role: "link", text: "I already installed OpenWork" }, { timeoutMs: 90_000 });
      expect(await webProbe.eval(() => document.querySelector('a[href="openwork://open"]') === null)).toBe(true);
      const href = await webProbe.eval(() => [...document.querySelectorAll<HTMLAnchorElement>("a")]
        .find((link) => link.textContent?.trim() === "I already installed OpenWork")?.href);
      expect(href).toBe(authUrl);
      await webProbe.eval(() => { document.documentElement.dataset.installDocument = "before-handoff"; });
      // Activate the real anchor default action without depending on OS focus
      // after the preceding custom-protocol handoff.
      await clickText(world.web, "I already installed OpenWork");
      await webUser.see({ testId: "desktop-signed-in-handoff" }, { timeoutMs: 90_000 });
      expect(await webProbe.eval(() => location.href)).toBe(authUrl);
      expect(await webProbe.eval(() => document.documentElement.dataset.installDocument ?? null)).toBeNull();
      await webUser.see({ text: world.den.admin.email });
      await webUser.notSee({ role: "textbox", label: /password/i });
      const deepLink = await probe.eventually(() => webProbe.eval(() =>
        [...document.querySelectorAll("input")].find((input) => input.value.startsWith("openwork://den-auth?"))?.value ?? ""
      ), { within: 60_000, label: "install-issued desktop grant", until: (value) => typeof value === "string" && value.includes("grant=") });
      if (typeof deepLink !== "string") throw new Error("Missing install handoff URL");
      const handoff = new URL(deepLink);
      const grant = handoff.searchParams.get("grant");
      expect(handoff.protocol).toBe("openwork:");
      expect(handoff.hostname).toBe("den-auth");
      expect(handoff.searchParams.get("denBaseUrl")).toBe(`${origin}/api/den`);
      expect(handoff.searchParams.has("token")).toBe(false);
      expect(grant).toBeTruthy();
      if (!grant) throw new Error("Missing desktop grant");
      expect(grants.has(grant)).toBe(false);
      grants.add(grant);
    }
    evidence.recordAssertionEvidence("Cloud install reuses browser authentication on the correct instance", "Both session-backed and token-backed install links performed full-page navigation to the desktop sign-in route, retained the signed-in identity and produced distinct real den-auth grants with the destination's /api/den URL and no install token. Session-backed navigation ignored the hosted config default; token-backed navigation used the config's root.", true);
  });

  await step("The browser-issued grant returns to the app", async () => {
    // TODO(primitive): read the browser-issued desktop handoff URL.
    const deepLink = await probe.eventually(
      () => webProbe.eval(() => {
        const input = [...document.querySelectorAll("input")].find((candidate) => candidate.value.startsWith("openwork://") && candidate.value.includes("grant="));
        if (input) return input.value;
        return document.querySelector<HTMLElement>('a[href^="openwork://"]')?.getAttribute("href") ?? "";
      }),
      { within: 120_000, label: "browser-issued desktop handoff URL", until: (value) => typeof value === "string" && value.startsWith("openwork://") },
    );
    if (typeof deepLink !== "string") throw new Error("The browser-issued handoff URL was not a string.");
    const handoff = new URL(deepLink);
    expect(handoff.hostname).toBe("den-auth");
    expect(handoff.searchParams.get("denBaseUrl")).toBe(`${new URL(world.den.ref.webUrl).origin}/api/den`);
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
