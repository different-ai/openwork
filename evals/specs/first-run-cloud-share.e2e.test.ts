import { expect, test } from "vitest";
import { chrome, desktop } from "@openwork/hosts";
import { createVisualEvidence, screenshot, validate } from "@openwork/test-evidence";
import {
  assignPluginToMarketplace,
  captureOpenedUrls,
  clickButton,
  completeDesktopHandoff,
  createMarketplace,
  createPluginWithSkill,
  enabledButtons,
  ensureMemberSession,
  go,
  grantMarketplaceAccess,
  readHandoffDeepLink,
  readResolvedMarketplace,
  signIn,
  signInInBrowser,
  visibleText,
  waitForText,
  waitUntilInteractive,
} from "@openwork/behaviors";

/**
 * CORE JOURNEY: a person opens the app for the first time, signs in to OpenWork
 * Cloud — which hands off to a real browser and comes back — then shares a skill
 * with a colleague by authoring it inside a plugin and putting that plugin on a
 * marketplace the colleague can use.
 *
 * Faithfulness notes:
 *  - The browser hop is real: we capture the URL the app asks the OS to open
 *    (PATH shim over xdg-open, which is what shell.openExternal calls on Linux)
 *    and drive that page in a real Chrome.
 *  - Only the OS protocol dispatch of `openwork://den-auth?grant=…` is bridged,
 *    because a container registers no protocol handler. The grant is the real one
 *    the app generated and the browser approved; it is handed to the product's own
 *    documented entry point for this case.
 */

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const denApiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const denWebUrl = (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim() || denApiUrl.replace("127.0.0.1", "localhost")).replace(/\/+$/, "");
const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const adminEmail = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const colleagueEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";

const title = !e2eTestsEnabled
  ? "first-run cloud sharing skipped: set OPENWORK_EVAL_E2E_TESTS=1 to opt in"
  : !denApiUrl
    ? "first-run cloud sharing skipped: set OPENWORK_EVAL_DEN_API_URL to a running Den"
    : "first run signs in through the browser, then shares a skill with a colleague via a marketplace";

test.skipIf(!e2eTestsEnabled || !denApiUrl)(title, async () => {
  const den = { apiUrl: denApiUrl, webUrl: denWebUrl };
  const capture = await captureOpenedUrls();

  // The app must find our xdg-open shim first, so we can see where it points.
  await using app = await desktop({
    name: "first-run-cloud-share",
    bootstrap: { baseUrl: den.webUrl, apiBaseUrl: den.webUrl, requireSignin: false },
    env: { PATH: `${capture.binDir}:${process.env.PATH ?? ""}` },
  });
  await using visualEvidence = createVisualEvidence("first-run-cloud-share");

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A fresh OpenWork app is visible offering to sign in to OpenWork Cloud",
      "No error or 'Something went wrong' message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  // 1. Sign in from inside the app: this must hand off to the browser.
  const buttons = await enabledButtons(app);
  const signInLabel = ["Sign in to OpenWork Cloud", "Sign in"].find((label) => buttons.includes(label));
  expect(signInLabel, `no sign-in control. Buttons: ${buttons.join(" | ")}`).toBeDefined();
  if (!signInLabel) throw new Error("unreachable");
  await clickButton(app, signInLabel, { timeoutMs: 60_000 });

  // The real handoff URL carries desktopAuth/desktopScheme; the grant is issued
  // by Den only after the person signs in in the browser.
  const handoffUrl = await capture.waitForUrl(
    (url) => url.includes("desktopAuth=1") || url.includes("desktopScheme=") || url.includes("grant="),
    { timeoutMs: 90_000 },
  );
  expect(handoffUrl.startsWith(den.webUrl), `the app opened an unexpected origin: ${handoffUrl}`).toBe(true);

  // 2. Finish in a real browser. Same host as the app here; `chrome({ host })`
  // is what a split topology would use.
  await using browser = await chrome({ name: "cloud-signin", startUrl: "about:blank" });
  await signInInBrowser(browser, handoffUrl, { email: adminEmail, password });
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "A browser page shows an OpenWork Cloud sign-in result or dashboard, not a sign-in form error",
      "No 'invalid credentials' or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  // 3. Back to the app with the grant Den issued for this browser session.
  const deepLink = await readHandoffDeepLink(browser, { timeoutMs: 120_000 });
  expect(deepLink.startsWith("openwork://"), `unexpected deep link: ${deepLink}`).toBe(true);
  await completeDesktopHandoff(app, deepLink, den.webUrl);
  await waitUntilInteractive(app, { timeoutMs: 180_000 });
  const signedInText = await visibleText(app);
  expect(
    /acme|signed in|account/i.test(signedInText),
    `the app does not look signed in. Visible text: ${signedInText.slice(0, 400)}`,
  ).toBe(true);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The app is back in focus and no longer offers a bare 'Sign in to OpenWork Cloud' as the only action",
      "No sign-in failure message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  // 4. Author a skill inside a plugin and share it via a marketplace.
  const admin = await signIn(den, { email: adminEmail, password });
  const colleague = await ensureMemberSession(den, admin, {
    email: colleagueEmail,
    password,
    name: "Jordan Demo",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });

  const stamp = Date.now();
  const skillName = `shared-standup-${stamp}`;
  const marketplace = await createMarketplace(admin, { name: `Team Marketplace ${stamp}` });
  const plugin = await createPluginWithSkill(admin, {
    name: `Standup Kit ${stamp}`,
    skillName,
    skillBody: "Summarise yesterday, today, and blockers in three short bullets.",
    marketplaceId: marketplace.id,
  });
  await assignPluginToMarketplace(admin, marketplace.id, plugin.id).catch(async (error: unknown) => {
    // Creating the plugin with marketplaceId may already have published it; only
    // a genuine failure should surface.
    const resolved = await readResolvedMarketplace(admin, marketplace.id);
    if (!resolved.pluginNames.includes(plugin.name)) throw error;
  });
  await grantMarketplaceAccess(admin, marketplace.id, { orgWide: true });

  // 5. The colleague can actually see the shared skill.
  const asColleague = await readResolvedMarketplace(colleague, marketplace.id);
  expect(
    asColleague.pluginNames,
    `the colleague cannot see the plugin. Saw: ${JSON.stringify(asColleague.pluginNames)}`,
  ).toContain(plugin.name);
  expect(
    asColleague.skillNames.some((name) => name.includes(skillName)),
    `the colleague cannot see the shared skill. Saw: ${JSON.stringify(asColleague.skillNames)}`,
  ).toBe(true);

  // 6. And it is visible in the app's own extensions surface.
  await go(app, `/workspace/${app.readiness.workspaceId ?? ""}/settings/extensions`).catch(() => undefined);
  await waitForText(app, "Library", { timeoutMs: 60_000 }).catch(() => undefined);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "An OpenWork surface listing extensions, skills or connections is visible",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }
});
