import { expect } from "vitest";
import { test, server, needs, screenshot } from "@openwork/testkit";
import { validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { fill, clickText, waitFor, evalIn } from "@openwork/behaviors";
import { addInitScript, navigate } from "@openwork/cdp";

test("first administrator passwords must match before setup creates an account", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const email = "admin@example.test";
  const setupCode = "isolated-setup-fixture";
  await using den = await server({ place, provision: false, env: {
    DEN_ORG_MODE: "single_org", DEN_SINGLE_ORG_OWNER_EMAILS: email,
    DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "false", DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: setupCode,
    DATABASE_REDIS_URL: "",
  } });
  await using browser = await chrome({ host: place.host(), startUrl: "about:blank", headless: true });
  await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Observe requests without replacing the real bootstrap or auth responses.
  await using observer = await addInitScript(browser.client, () => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/auth/sign-up/email")) {
        sessionStorage.setItem("setup-test-signups", String(Number(sessionStorage.getItem("setup-test-signups") ?? "0") + 1));
      }
      return originalFetch(input, init);
    };
  });
  const signupRequests = () => evalIn(browser, () => Number(sessionStorage.getItem("setup-test-signups") ?? "0"));
  await navigate(browser.client, `${den.ref.webUrl}/setup`);
  {
    await waitFor(browser, () => Boolean(document.querySelector("#setup-email")), { timeoutMs: 90_000 });
    await fill(browser, "#setup-email", email);
    await fill(browser, "#setup-code", setupCode);
    await clickText(browser, "Continue");
    await waitFor(browser, () => Boolean(document.querySelector("#setup-confirm-password")), { timeoutMs: 30_000 });
    expect(await evalIn(browser, () => document.querySelector("#setup-password-hint")?.textContent)).toContain("8–32 characters with uppercase and lowercase letters, a number, and a special character");
    expect(await evalIn(browser, () => [...document.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]')].map((input) => input.type))).toEqual(["password", "password"]);
    expect(await evalIn(browser, () => {
      const frame = document.querySelector('[data-testid="initial-admin-setup"]')?.getBoundingClientRect();
      return Boolean(frame && frame.width > 0 && frame.top >= 0 && frame.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth);
    })).toBe(true);
    expect((await validate(await screenshot(browser), [
      "The setup form shows Password, Confirm password, Show passwords, and the 8–32 character policy hint.",
      "The form and Create administrator button are readable without overlapping or clipped controls.",
    ])).ok).toBe(true);

    await fill(browser, "#setup-name", "Administrator");
    await fill(browser, "#setup-password", "short");
    await fill(browser, "#setup-confirm-password", "short");
    await clickText(browser, "Create administrator");
    await waitFor(browser, () => document.querySelector('[role="alert"]')?.textContent === "Use at least 8 characters for your password.");
    expect(await evalIn(browser, () => document.querySelector<HTMLInputElement>("#setup-password")?.minLength)).toBe(8);
    expect(await signupRequests()).toBe(0);

    await fill(browser, "#setup-password", "SetupPassword123!");
    await fill(browser, "#setup-confirm-password", "DifferentPassword123!");
    await clickText(browser, "Create administrator");
    await waitFor(browser, () => Boolean(document.querySelector('[role="alert"]')));
    expect(await evalIn(browser, () => document.querySelector('[role="alert"]')?.textContent)).toBe("Passwords do not match. Re-enter your confirmation password.");
    expect(await signupRequests()).toBe(0);
    const status = () => fetch(`${den.ref.apiUrl}/v1/auth/bootstrap/status`).then((response) => response.json());
    expect(await status()).toMatchObject({ status: "available" });
    expect((await validate(await screenshot(browser), [
      "Both password entries are masked, and the form shows: Passwords do not match. Re-enter your confirmation password.",
      "The mismatch error and Create administrator button are fully visible without overlapping controls.",
    ])).ok).toBe(true);
    evidence.recordAssertionEvidence("Invalid passwords stay local", "A short password and a mismatch each display an actionable error. Neither sends a signup request or creates a user: bootstrap remains available. The password input also declares an 8-character native minimum.", true);

    await clickText(browser, "Show passwords");
    expect(await evalIn(browser, () => [...document.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]')].map((input) => ({ type: input.type, value: input.value })))).toEqual([
      { type: "text", value: "SetupPassword123!" }, { type: "text", value: "DifferentPassword123!" },
    ]);
    await clickText(browser, "Hide passwords");
    expect(await evalIn(browser, () => [...document.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]')].map((input) => input.type))).toEqual(["password", "password"]);
    expect(await signupRequests()).toBe(0);
    await browser.client.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
    expect(await evalIn(browser, () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await validate(await screenshot(browser), [
      "The narrow setup form shows both masked password inputs, the Show passwords control, the mismatch error, and the Create administrator button without horizontal clipping.",
    ])).ok).toBe(true);
    evidence.recordAssertionEvidence("Visibility preserves entries and does not submit", "Both new-password fields start masked, Show passwords reveals both existing values, and Hide passwords masks them again without signup. The form fits a 390px viewport horizontally.", true);

    const verification = await fetch(`${den.ref.apiUrl}/v1/auth/bootstrap/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: setupCode }),
    });
    const payload: unknown = await verification.json();
    if (!payload || typeof payload !== "object" || !("grant" in payload) || typeof payload.grant !== "string") throw new Error("Bootstrap verification did not issue a grant");
    const shortSignup = await fetch(`${den.ref.apiUrl}/api/auth/sign-up/email`, {
      method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
      body: JSON.stringify({ email, name: "Administrator", password: "short", bootstrapGrant: payload.grant }),
    });
    expect(shortSignup.status).toBe(400);
    expect(await shortSignup.json()).toMatchObject({ error: "password_too_short" });
    expect(await status()).toMatchObject({ status: "available" });
    evidence.recordAssertionEvidence("The server still enforces password length", "A direct signup with a valid bootstrap grant and a short password is rejected with password_too_short, leaving setup available. Client confirmation does not replace Den API validation.", true);

    await fill(browser, "#setup-confirm-password", "SetupPassword123!");
    await clickText(browser, "Create administrator");
    await waitFor(browser, () => location.pathname !== "/setup", { timeoutMs: 60_000, label: "first administrator signed in" });
    expect(await signupRequests()).toBe(1);
    expect(await status()).toMatchObject({ status: "complete" });
    const session = await evalIn(browser, async () => {
      const response = await fetch("/api/auth/get-session", { credentials: "include" });
      const body = await response.json();
      return { status: response.status, email: body?.user?.email };
    }, { awaitPromise: true });
    expect(session).toEqual({ status: 200, email });
    await navigate(browser.client, `${den.ref.webUrl}/setup`);
    await waitFor(browser, () => document.querySelector("h1")?.textContent === "Setup is complete", { timeoutMs: 30_000 });
    expect(await evalIn(browser, () => document.querySelector("form") === null)).toBe(true);
    const verifyAgain = await fetch(`${den.ref.apiUrl}/v1/auth/bootstrap/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: setupCode }),
    });
    expect(verifyAgain.status).toBe(409);
    evidence.recordAssertionEvidence("Corrected confirmation completes one-time setup", "Correcting the confirmation sends exactly one signup, establishes the administrator session, and closes bootstrap. Revisiting setup shows complete with no form; the same setup code is rejected with 409.", true);
  }
});
