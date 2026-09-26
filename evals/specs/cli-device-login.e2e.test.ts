import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { cliDeviceLogin } from "../worlds/cli-device-login.ts";

const test = spec.world(cliDeviceLogin, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm", "node"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a person signs the OpenWork CLI in from their browser without typing a password", async ({ world, user, step, evidence }) => {
  const person = user.on(world.web);

  await step("before: the CLI has no saved sign-in and cannot act for the person", async () => {
    const onboard = await world.run(["cloud", "onboard", "--base-url", world.den.ref.apiUrl, "--org-name", "Should not exist", "--invite-email", "teammate@example.com"]);
    const refused = onboard.status !== 0 && onboard.stderr.includes("not_signed_in: run \"openwork-bootstrap login");
    evidence.recordAssertionEvidence(
      "Without a sign-in the CLI points at `login` instead of asking for a password",
      `exit ${onboard.status}; stderr: ${onboard.stderr.trim().split("\n")[0]}`,
      refused,
    );
    expect(refused).toBe(true);
    expect(world.savedCredentials()).toBeNull();
  });

  const login = await world.startLogin();

  await step("the CLI shows a link and a one-time code, and the browser page shows the same code", async () => {
    const url = new URL(login.verificationUrl);
    expect(url.origin).toBe(new URL(world.den.ref.webUrl).origin);
    expect(url.pathname).toBe("/device");
    await person.navigate(login.verificationUrl);
    await person.see({ text: "Sign in OpenWork CLI?" }, { timeoutMs: 90_000 });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ text: world.den.admin.email });
    await person.see({ testId: "device-consent-line" });
    evidence.recordAssertionEvidence(
      "The code in the terminal matches the code on the page",
      `terminal: ${login.userCode}; page: /device?user_code=… on Den web, signed in as ${world.den.admin.email}`,
      true,
    );
    await person.screenshot();
  });

  await step("after: the person approves and the CLI receives a session it can use", async () => {
    await person.click({ role: "button", label: "Sign in OpenWork CLI" });
    await person.see({ text: /OpenWork CLI is signed in/ }, { timeoutMs: 30_000 });
    await person.screenshot();
    const result = await login.finished;
    expect(result.status, result.stderr).toBe(0);
    const out: unknown = JSON.parse(result.stdout);
    expect(out).toMatchObject({ ok: true, source: "login", user: { email: world.den.admin.email } });
    const saved = world.savedCredentials();
    expect(saved).not.toBeNull();
    expect(saved?.mode).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain(saved?.accessToken ?? "missing");
    const me = await world.me(saved?.accessToken ?? "");
    const meBody: unknown = me.body;
    expect(me.response.status).toBe(200);
    expect(meBody).toMatchObject({ user: { email: world.den.admin.email } });
    evidence.recordAssertionEvidence(
      "The saved token authenticates as the person who approved",
      `login exit 0; credentials file mode ${saved?.mode.toString(8)}; GET /v1/me → ${me.response.status} ${world.den.admin.email}; token never printed`,
      true,
    );
  });

  await step("a second request the person denies leaves the CLI without a new session", async () => {
    const second = await world.startLogin(["--force"]);
    await person.navigate(second.verificationUrl);
    await person.see({ testId: "device-user-code", text: second.userCode }, { timeoutMs: 60_000 });
    await person.click({ role: "button", label: "Deny" });
    await person.see({ text: /Sign-in denied/ });
    await person.screenshot();
    const result = await second.finished;
    const denied = result.status !== 0 && result.stderr.includes("login_denied");
    evidence.recordAssertionEvidence(
      "A denied code never becomes a session",
      `second login exit ${result.status}; stderr mentions login_denied: ${denied}`,
      denied,
    );
    expect(denied).toBe(true);
  });
});
