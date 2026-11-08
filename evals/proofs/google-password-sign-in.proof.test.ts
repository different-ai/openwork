import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { googlePasswordSignIn } from "../worlds/google-password-sign-in.ts";

const test = spec.world(googlePasswordSignIn, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a member with an existing password signs in through Google to the same account", async ({ world, user, probe, step, evidence }) => {
  await step("a password member reaches the password form without a Google identity", async () => {
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ role: "textbox", label: "Password" });
    expect(world.before.filter((row) => row.email === world.person.email).map((row) => row.provider_id)).toEqual(["credential"]);
    evidence.recordAssertionEvidence("The starting account has only a password", "The database contains one credential identity and no Google identity for the member; the browser is signed out at the password step.", world.before.filter((row) => row.email === world.person.email).every((row) => row.provider_id === "credential"));
    // Deliberately capture before looking for the missing control: the exact same
    // proof fails here on the base and retains a screenshot of issue #5909.
    await user.screenshot();
  });

  await step("after: the password member can choose Google without entering a password", async () => {
    await user.see({ role: "button", label: "Sign in with Google" });
    await user.see({ role: "button", label: "Forgot password?" });
    evidence.recordAssertionEvidence("Google is available beside password recovery", "The existing password step offers Sign in with Google; no password has been entered.", (await probe.text()).includes("Sign in with Google"));
    await user.screenshot();
    await user.click({ role: "button", label: "Sign in with Google" });
  });

  await step("Google shows its account chooser and asks for consent", async () => {
    await user.see({ text: "Choose an account" });
    await user.screenshot();
    await user.click({ role: "button", label: new RegExp(world.person.email.replaceAll(".", "\\.")) });
    await user.see({ role: "button", label: "Continue" });
    expect(world.browser.requests).toHaveLength(1);
    expect(world.browser.requests[0]).toMatchObject({ provider: "google" });
    expect(world.browser.requests[0]).not.toHaveProperty("password");
    const authorization = new URL(world.browser.authorizationRequests[0]!);
    expect(authorization.searchParams.get("state")).toBeTruthy();
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    evidence.recordAssertionEvidence("The real Google adapter started authorization", "Den sent provider=google without a password and produced a state-bound authorization URL with S256 PKCE; the loopback provider rendered the chooser and consent page.", authorization.searchParams.get("code_challenge_method") === "S256" && world.browser.requests[0]?.provider === "google");
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
  });

  await step("denied consent creates neither a session nor a linked Google account", async () => {
    await probe.eventually(() => world.browser.callbackResponses, {
      within: 15_000, label: "completed access_denied callback",
      until: (responses) => responses.some((response) => response.error === "access_denied"),
    });
    await user.see({ text: /denied|error|sign in/i });
    await user.screenshot();
    expect(await world.session()).toBeNull();
    expect(await world.accountRows()).toEqual(world.before);
    evidence.recordAssertionEvidence("Declining Google leaves both accounts untouched", "After access_denied, the browser has no authenticated session and both password accounts have exactly their original identity rows.", await world.session() === null && JSON.stringify(await world.accountRows()) === JSON.stringify(world.before));
    await user.navigate(world.den.ref.webUrl);
    await user.see({ role: "textbox", label: "Email" });
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.click({ role: "button", label: "Sign in with Google" });
    await user.see({ text: "Choose an account" });
    await user.click({ role: "button", label: new RegExp(world.person.email.replaceAll(".", "\\.")) });
    await user.click({ role: "button", label: "Continue" });
  });

  await step("after: Google signs the member into their original workspace and account", async () => {
    await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
    const session = await probe.eventually(() => world.session(), {
      within: 15_000, label: "Google-authenticated browser session", until: (value) => value?.id === world.personId,
    });
    expect(session).toMatchObject({ id: world.personId, email: world.person.email });
    const accounts = await world.accountRows();
    expect(accounts.filter((row) => row.email === world.person.email)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: world.personId, provider_id: "credential" }),
      expect.objectContaining({ id: world.personId, provider_id: "google", account_id: "google-password-member" }),
    ]));
    expect(accounts.filter((row) => row.email === world.person.email)).toHaveLength(2);
    expect(accounts.filter((row) => row.email === world.other.email)).toEqual(world.before.filter((row) => row.email === world.other.email));
    expect(world.provider.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "consent", error: "access_denied" }),
      expect.objectContaining({ type: "token", sub: "google-password-member" }),
    ]));
    expect(world.browser.failures).toEqual([]);
    expect(world.browser.consoleErrors).toEqual([]);
    expect(world.browser.httpErrors.filter((response) => !(response.status === 401 && response.path === "/api/browser/v1/me"))).toEqual([]);
    evidence.recordAssertionEvidence("Google linked to the correct existing user", `The browser session user is the original password user ${world.personId}; credential and google identities share that ID, no duplicate user was created, and the other member's account is unchanged.`, session?.id === world.personId && accounts.filter((row) => row.email === world.person.email).length === 2);
    await user.screenshot();
  });
});
