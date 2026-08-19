import { expect, test } from "vitest";
import { desktop } from "@openwork/hosts";
import { startEgressLab } from "@openwork/labs";
import { clickButton, diagnoseEgressLabProduct, enabledButtons, visibleText, waitUntilInteractive } from "@openwork/behaviors";
import { matchVerdictExpectations } from "@openwork/matchers";
import { createVisualEvidence, screenshot, validate } from "@openwork/test-evidence";

/**
 * CORE JOURNEY: a desktop pointed at a Den whose TLS is broken by the corporate
 * edge — the Blue Yonder shape, where five days went to blaming the wrong thing.
 *
 * This is deliberately a *welcome-surface* journey: the app is bootstrapped at a
 * Den served by the egress lab, so the fault surfaces before any workspace,
 * model or onboarding exists. What we require is that the app is HONEST about it
 * — it must say something a person can act on, not spin forever.
 */

const optedIn = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = optedIn
  ? "a desktop pointed at a TLS-intercepted Den never claims it is connected, and diagnostics name the interception"
  : "app + TLS-broken Den skipped: set OPENWORK_EVAL_E2E_TESTS=1 to opt in";

test.skipIf(!optedIn)(title, async () => {
  // The lab re-signs TLS with a CA the app does not trust: a corporate
  // interception proxy, as far as the desktop is concerned.
  await using edge = await startEgressLab({ profile: "intercept" });
  await using app = await desktop({
    name: "den-tls-fault",
    bootstrap: { baseUrl: edge.url, apiBaseUrl: edge.url, requireSignin: false },
  });
  await using visualEvidence = createVisualEvidence("app-den-tls-fault");

  // A fresh profile bootstrapped at a Den lands with no workspace yet — either
  // the welcome surface or the session surface offering to create one. Both are
  // fine here: what matters is that no workspace/model/onboarding is needed to
  // reach the Den.
  expect(["welcome", "no-workspace"]).toContain(app.readiness.state);
  const beforeText = await visibleText(app);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "An OpenWork screen offering to sign in to OpenWork Cloud is visible",
      "No error or 'Something went wrong' crash message is visible yet",
    ]);
    expect(seen.ok, seen.why).toBe(true);
    await visualEvidence.recordScreenshot(shot, seen);
  }

  // Attempting to reach the Den is what exercises the broken edge. The
  // affordance differs by surface, so use whichever the app is showing.
  // Pick from actual enabled buttons: "Sync with OpenWork Cloud" appears in the
  // text but is not a control, which a text match would wrongly select.
  const buttons = await enabledButtons(app);
  const signInLabel = ["Sign in to OpenWork Cloud", "Sign in", "Sync with OpenWork Cloud"]
    .find((label) => buttons.includes(label));
  expect(signInLabel, `no sign-in button on screen. Buttons: ${buttons.join(" | ")}`).toBeDefined();
  if (!signInLabel) throw new Error("unreachable: no sign-in affordance");
  await clickButton(app, signInLabel, { timeoutMs: 60_000 });
  await waitUntilInteractive(app, { timeoutMs: 180_000 });

  // No second frame: sign-in against a TLS-intercepted Den changes nothing on
  // screen, so another capture would be the same pixels — visual evidence refuses
  // duplicates precisely so we cannot pad the evidence.
  const afterText = await visibleText(app);

  // The app must never claim success it does not have. Observed behaviour with a
  // TLS-intercepted Den is that sign-in produces no in-app feedback (the desktop
  // hands off to a browser), so what we require here is the absence of a false
  // positive rather than a specific error string.
  for (const claim of ["Signed in as", "Synced", "Connected to OpenWork Cloud"]) {
    expect(afterText.includes(claim), `app claimed "${claim}" while the Den is TLS-intercepted`).toBe(false);
  }

  // And the shipped diagnostics must NAME the interception for that endpoint —
  // this is the half that turns "it is broken" into "here is what to fix".
  const verdict = await diagnoseEgressLabProduct(edge);
  expect(verdict.available, verdict.text).toBe(true);
  expect(
    matchVerdictExpectations(verdict.text, "intercept").ok,
    `diagnostics did not name TLS interception: ${verdict.text}`,
  ).toBe(true);
});
