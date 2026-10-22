import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { getPasswordPolicyHint, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "@openwork/types/den/password-policy";
import { z } from "zod";
import { emptySsoForm, initialAdministratorPassword, manualOidc, savedSamlValues, ssoConnection } from "../worlds/sso-provider-values.ts";

const savedSamlTest = spec.world(savedSamlValues, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 300_000 });
const empty = spec.world(emptySsoForm, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 300_000 });
const setup = spec.world(initialAdministratorPassword, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 300_000 });
type SsoWorld = Awaited<ReturnType<typeof savedSamlValues>>;

async function checkCopies(user: User, probe: Probe, world: SsoWorld) {
  const rows = await world.rows();
  for (const row of rows) {
    await user.click({ role: "button", label: `Copy ${row.label}` });
    await probe.eventually(world.clipboard, { within: 10_000, until: value => value === row.value, label: `Copied ${row.label} matches its displayed value` });
  }
  return rows;
}

savedSamlTest("generic setup follows the saved protocol despite unsaved form tabs, and every Copy button copies its own value", async ({ world, user, probe, seed, step, evidence }) => {
  const savedConnection = world.savedConnection;
  if (!savedConnection) throw new Error("Expected a saved SAML connection");
  expect(savedConnection.acsUrl).toContain("https://ow.ai.example.test/api/auth/sso/saml2/sp/acs/");
  // Host equality belongs to the independent callback proof. This screen renders
  // the public API-provided value and must compose with that separate change.
  expect(new URL(savedConnection.redirectUrl).pathname).toBe(`/api/auth/sso/callback/${encodeURIComponent(savedConnection.providerId)}`);
  await user.see({ testId: "sso-provider-setup" }, { timeoutMs: 60_000 });
  const saml = await step("after: saved SAML offers only its four correctly paired setup values", async () => {
    const rows = await checkCopies(user, probe, world);
    const precedes = await world.setupPrecedesVerification();
    expect(precedes).toBe(true);
    expect(rows.map(row => row.label)).toEqual(["Entity ID", "ACS URL (Reply URL)", "Sign-in URL", "Metadata URL"]);
    expect(rows.map(row => row.value)).toEqual(["https://ow.ai.example.test", savedConnection.acsUrl, savedConnection.signInUrl, savedConnection.metadataUrl]);
    expect(rows.some(row => row.value === savedConnection.redirectUrl)).toBe(false);
    expect((await probe.dom('[data-testid="sso-provider-setup"] button')).elements).toHaveLength(4);
    const copy = (await probe.dom('[data-testid="sso-provider-setup"]')).elements.map(row => row.text).join(" ");
    expect(copy).not.toMatch(/OIDC|Microsoft|Entra|Okta/);
    evidence.recordAssertionEvidence("SAML has four working Copy values and no OIDC callback", JSON.stringify(rows.map(row => ({ label: row.label, value: row.value }))), rows.length === 4 && precedes && !rows.some(row => row.value === savedConnection.redirectUrl));
    await user.screenshot();
    return rows;
  });

  await step("the administrator sees the password lockout warning and the existing form guidance", async () => {
    await user.click({ role: "button", label: "Enable Config" });
    await user.see({ testId: "sso-test-dialog" });
    expect((await probe.dom('[data-testid="sso-test-dialog"]')).elements[0].text).toContain("Once enabled, email and password sign-in stops for everyone in this workspace, including you. Keep this admin session open until you have signed in with SSO.");
    await user.screenshot();
    await user.click({ role: "button", label: "Close" });
    await user.click({ role: "button", label: "Edit connection" });
    await user.see({ role: "textbox", label: /^IdP Certificate/ });
    const labels = (await probe.dom("label > span:first-child")).elements.map(label => label.text);
    expect(labels[0]).toBe("Users' email domain");
    expect(labels[1]).toBe("IdP Issuer URL");
    await user.see({ role: "textbox", label: /^Users' email domain/ }, { value: "example.test" });
    expect((await probe.dom("details[open]")).elements).toHaveLength(0);
    const guidance = await probe.text();
    expect(guidance).toContain("We recommend signing SAML assertions with SHA-256.");
    expect(guidance).toContain("Your identity provider's own identifier (for example Microsoft Entra Identifier or Identity Provider Issuer). Not the Entity ID you give to your identity provider.");
    expect(guidance).toContain("Your identity provider's login address (for example Login URL, Identity Provider Single Sign-On URL or SSO URL).");
    // Native keyboard disclosure avoids a selector-based click or app evaluation.
    await user.click({ role: "textbox", label: /^IdP Certificate/ });
    await user.press("Tab");
    await user.press("Enter");
    await user.see({ role: "textbox", label: /^Audience URL/ });
    const advanced = (await probe.dom("details")).elements[0].text;
    expect(advanced).toContain("Leave blank to use OpenWork’s Entity ID (shown in the values to give your identity provider).");
    evidence.recordAssertionEvidence("the users' domain is first and Advanced retains the Entity ID default", `first fields=${labels.slice(0, 2).join(", ")}; ${advanced}`, labels[0] === "Users' email domain" && advanced.includes("Leave blank to use OpenWork’s Entity ID"));
    await user.screenshot();
  });

  await step("a wrong domain warns on blur while an unsaved OIDC tab cannot change saved SAML", async () => {
    await user.type({ role: "textbox", label: /^Users' email domain/ }, "example.test,wrong.test", { replace: true });
    await user.click({ text: "Paste the values from your identity provider" });
    const warning = await probe.eventually(() => probe.dom('[data-notice-tone="warning"]'), { within: 10_000, until: value => value.elements.length > 0, label: "Domain warning appears on blur" });
    expect(warning.elements[0].text).toContain("matches wrong.test.");
    expect(warning.elements[0].text).not.toContain("example.test");
    await user.screenshot();
    await user.type({ role: "textbox", label: /^Users' email domain/ }, " EXAMPLE.TEST , example.test ", { replace: true });
    await user.click({ text: "Paste the values from your identity provider" });
    await probe.eventually(() => probe.dom('[data-notice-tone="warning"]'), { within: 10_000, until: value => value.elements.length === 0, label: "Valid CSV clears the warning" });
    await user.type({ role: "textbox", label: /^Users' email domain/ }, "example.test", { replace: true });
    await user.click({ text: "Paste the values from your identity provider" });
    await user.click({ role: "button", label: "OIDC" });
    await user.see({ role: "textbox", label: /^Client ID/ });
    expect(await probe.text()).toContain("The issuer from your identity provider's OpenID configuration (not the authorize or token URL), e.g. https://login.microsoftonline.com/<tenant-id>/v2.0.");
    expect(await checkCopies(user, probe, world)).toEqual(saml);
    expect((await probe.dom('[data-sso-value="redirect"]')).elements).toHaveLength(0);
    const after = await probe.api(world.den.admin, "/v1/sso", { headers: world.headers });
    expect(after.response.status).toBe(200);
    expect(ssoConnection(after.body)).toEqual(savedConnection);
    evidence.recordAssertionEvidence("unsaved edits neither expose the OIDC callback nor persist a new connection", `SAML rows=${saml.length}; read HTTP ${after.response.status}; warning named only wrong.test`, after.response.status === 200 && JSON.stringify(ssoConnection(after.body)) === JSON.stringify(savedConnection));
    await user.screenshot();
  });

  await step("a saved OIDC connection exposes only Sign-in and Redirect, even under an unsaved SAML tab", async () => {
    const registered = await seed.api(world.den.admin, "/v1/sso/oidc", { method: "POST", headers: world.headers, body: JSON.stringify(manualOidc()) });
    expect(registered.response.status).toBe(201);
    const initial = await probe.api(world.den.admin, "/v1/sso", { headers: world.headers });
    expect(initial.response.status).toBe(200);
    const oidcConnection = ssoConnection(initial.body);
    if (!oidcConnection) throw new Error("Expected a saved OIDC connection");
    expect(oidcConnection.kind).toBe("oidc");
    await user.reload();
    await user.see({ testId: "sso-provider-setup" }, { timeoutMs: 60_000 });
    const oidc = await checkCopies(user, probe, world);
    expect(await world.setupPrecedesVerification()).toBe(true);
    expect(oidc.map(row => [row.label, row.value])).toEqual([["Sign-in URL", oidcConnection.signInUrl], ["Redirect URL", oidcConnection.redirectUrl]]);
    expect(oidc.some(row => row.value === savedConnection.acsUrl)).toBe(false);
    const outgoing = (await probe.dom('[data-testid="sso-provider-setup"]')).elements[0].text;
    expect(outgoing).toContain("Where your identity provider sends users back after sign-in. Paste it exactly as the app's redirect URI (Callback URL, Sign-in redirect URI or Authorized redirect URI). It must match character for character.");
    expect(outgoing).toContain("Optional. Some providers ask for it to start sign-in from their app portal (Sign on URL, Initiate login URI).");
    expect(oidcConnection).not.toHaveProperty("clientSecret");
    expect(oidcConnection.oidc).not.toHaveProperty("clientSecret");
    await user.click({ role: "button", label: "Edit connection" });
    await user.see({ role: "textbox", label: /^Client ID/ });
    await user.see({ role: "textbox", label: /^Client Secret/ }, { value: "" });
    const incoming = await probe.text();
    expect(incoming).toContain("OpenWork doesn't return the saved secret.");
    expect(incoming).toContain("Keep openid email profile. Each user needs an email address at your identity provider.");
    await user.screenshot();
    await user.click({ role: "button", label: "SAML" });
    await user.see({ role: "textbox", label: /^IdP Certificate/ });
    expect(await checkCopies(user, probe, world)).toEqual(oidc);
    expect((await probe.dom('[data-sso-value="acs"]')).elements).toHaveLength(0);
    const after = await probe.api(world.den.admin, "/v1/sso", { headers: world.headers });
    expect(after.response.status).toBe(200);
    expect(ssoConnection(after.body)).toEqual(oidcConnection);
    evidence.recordAssertionEvidence("the saved protocol alone controls the copy values", JSON.stringify(oidc), oidc.length === 2 && oidc[1].value === oidcConnection.redirectUrl && !oidc.some(row => row.value === savedConnection.acsUrl));
    await user.screenshot();
  });
});

empty("multi-domain blur warning names only unmatched entries and remains after a non-blocking UI save", async ({ world, user, probe, step, evidence }) => {
  await user.see({ role: "textbox", label: /^IdP Certificate/ }, { timeoutMs: 60_000 });
  await step("before: only the unmatched domain is warned, and blur does not save", async () => {
    await user.type({ role: "textbox", label: /^IdP Issuer URL/ }, "https://idp.example.test/issuer");
    await user.type({ role: "textbox", label: /^SAML Entry Point/ }, "https://idp.example.test/sso");
    await user.type({ role: "textbox", label: /^IdP Certificate/ }, world.cert);
    await user.type({ role: "textbox", label: /^Users' email domain/ }, "example.test,wrong.test", { replace: true });
    await user.click({ text: "Paste the values from your identity provider" });
    const warning = await probe.eventually(() => probe.dom('[data-notice-tone="warning"]'), { within: 10_000, until: value => value.elements.length > 0, label: "Warning appears before save" });
    expect(warning.elements[0].text).toContain("matches wrong.test.");
    expect(warning.elements[0].text).not.toContain("example.test");
    const initial = await probe.api(world.den.admin, "/v1/sso");
    expect(ssoConnection(initial.body)).toBeNull();
    evidence.recordAssertionEvidence("blur warns about wrong.test without saving the form", warning.elements[0].text, ssoConnection(initial.body) === null && warning.elements[0].text.includes("matches wrong.test.") && !warning.elements[0].text.includes("example.test"));
    await user.screenshot();
  });
  await step("after: the same warning remains after an ordinary non-blocked save", async () => {
    const before = (await probe.dom('[data-notice-tone="warning"]')).elements[0].text;
    await user.click({ role: "button", label: "Save SSO connection" });
    await user.see({ role: "button", label: "Edit connection" }, { timeoutMs: 60_000 });
    expect((await probe.dom('[role="alert"]')).elements).toHaveLength(0);
    expect((await probe.dom('[data-notice-tone="warning"]')).elements[0].text).toBe(before);
    const saved = await probe.api(world.den.admin, "/v1/sso");
    expect(saved.response.status).toBe(200);
    expect(ssoConnection(saved.body)?.domain).toBe("example.test,wrong.test");
    expect(await world.setupPrecedesVerification()).toBe(true);
    evidence.recordAssertionEvidence("saving preserves both submitted domains and the advisory warning", `saved domain=${ssoConnection(saved.body)?.domain}; warning=${before}`, saved.response.status === 200 && ssoConnection(saved.body)?.domain === "example.test,wrong.test");
    await user.screenshot();
  });
});

setup("initial administrator setup preserves a 40-character paste, shows an inline error and blocks submission without truncation", async ({ world, user, probe, step, evidence }) => {
  await step("the administrator reaches setup normally and sees the complete shared rule", async () => {
    await user.see({ role: "textbox", label: /^Administrator email$/i }, { timeoutMs: 60_000 });
    await user.type({ role: "textbox", label: /^Administrator email$/i }, "admin@example.test");
    await user.type({ role: "textbox", label: /^One-time setup code$/i }, world.code, { sensitive: true });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "textbox", label: /^Password$/i }, { timeoutMs: 60_000 });
    const policy = await world.passwordState();
    expect(policy.min).toBe(MIN_PASSWORD_LENGTH);
    expect(policy.max).toBe(-1);
    expect(policy.hint?.trim()).toBe(getPasswordPolicyHint());
    expect(policy.hint).toContain("uppercase letter (A–Z)");
    expect(policy.hint).toContain("lowercase letter (a–z)");
    expect(policy.hint).toContain("a number (0–9)");
    expect(policy.hint).toContain("a special character");
    expect(policy.hint).toContain("password strength is also checked");
    expect(policy.describedBy).toBe("setup-password-policy");
    evidence.recordAssertionEvidence("setup shows every existing rule without a native truncation limit", policy.hint ?? "missing hint", policy.min === 8 && policy.max === -1 && policy.hint?.trim() === getPasswordPolicyHint());
    await user.screenshot();
  });
  await step("the public sign-up endpoint keeps every original length, composition and strength rejection", async () => {
    const verification = await fetch(`${world.den.ref.apiUrl}/v1/auth/bootstrap/verify`, { method: "POST", headers: { "content-type": "application/json", origin: world.den.ref.webUrl }, body: JSON.stringify({ email: "admin@example.test", code: world.code }) });
    expect(verification.status).toBe(200);
    const { grant } = z.object({ grant: z.string().min(1) }).parse(await verification.json());
    const candidates = [
      { password: "Aa1!abc", error: "password_too_short" }, { password: "A".repeat(33), error: "password_too_long" },
      { password: "quiet-harbor-77!", error: "password_missing_uppercase" }, { password: "QUIET-HARBOR-77!", error: "password_missing_lowercase" },
      { password: "QuietHarbor773922", error: "password_missing_special_character" }, { password: "Quiet-Harbor-Brook!", error: "password_missing_digit" },
      { password: "Password123!", error: "password_too_weak" },
    ];
    const observed: string[] = [];
    for (const candidate of candidates) {
      const rejected = await fetch(`${world.den.ref.apiUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: world.den.ref.webUrl }, body: JSON.stringify({ email: "admin@example.test", name: "Example Admin", password: candidate.password, bootstrapGrant: grant }) });
      expect(rejected.status).toBe(400);
      const result: unknown = await rejected.json();
      expect(result).toMatchObject({ error: candidate.error });
      observed.push(z.object({ error: z.string() }).parse(result).error);
    }
    evidence.recordAssertionEvidence("all seven unchanged server-policy cases reject without creating an account", observed.join(", "), observed.length === 7 && observed.every((error, index) => error === candidates[index].error));
  });
  await step("after: all 40 pasted characters remain and the error is associated with the field", async () => {
    await user.type({ role: "textbox", label: /^Name$/i }, "Example Admin");
    await user.type({ role: "textbox", label: /^Password$/i }, "x".repeat(40), { sensitive: true });
    await user.see({ role: "alert" }, { text: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` });
    await user.see({ role: "textbox", label: /^Password$/i }, { value: "x".repeat(40) });
    const invalid = await world.passwordState();
    expect(invalid.length).toBe(40);
    expect(invalid.error).toBe(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
    expect(invalid.invalid).toBe("true");
    expect(invalid.describedBy).toContain("setup-password-error");
    expect(invalid.customError).toBe(true);
    expect(invalid.valid).toBe(false);
    evidence.recordAssertionEvidence("the field preserves the paste and describes its actionable error", `retained=${invalid.length}; invalid=${invalid.invalid}; describedBy=${invalid.describedBy}; ${invalid.error}`, invalid.length === 40 && invalid.customError && !invalid.valid && invalid.describedBy?.includes("setup-password-error") === true);
    await user.screenshot();
  });
  await step("native submission and the independent React guard send no additional authentication request", async () => {
    const before = await world.authPosts();
    await user.click({ role: "button", label: "Create administrator" });
    // A narrow fixture event retains the independent React-guard assertion from
    // the previous proof; it does not replace HTML, input or an API response.
    await world.submitWithoutNativeValidation();
    const blocked = await world.passwordState();
    expect({ length: blocked.length, valid: blocked.valid, submitting: blocked.submitting }).toEqual({ length: 40, valid: false, submitting: false });
    const after = await world.authPosts();
    expect(after).toBe(before);
    evidence.recordAssertionEvidence("neither submit path truncates the password or posts to authentication", `retained=${blocked.length}; valid=${blocked.valid}; submitting=${blocked.submitting}; auth POST delta=${after - before}`, blocked.length === 40 && !blocked.valid && blocked.submitting === false && after === before);
  });
  await step("correcting the length clears the error without silently creating an administrator", async () => {
    await user.type({ role: "textbox", label: /^Password$/i }, "x".repeat(MAX_PASSWORD_LENGTH), { replace: true, sensitive: true });
    await probe.eventually(() => world.passwordState(), { within: 10_000, until: value => value.error === null, label: "Overlong-password error clears when corrected" });
    const corrected = await world.passwordState();
    expect(corrected.valid).toBe(true);
    const response = await fetch(`${world.den.ref.apiUrl}/v1/auth/bootstrap/status`);
    expect(response.status).toBe(200);
    const status: unknown = await response.json();
    expect(status).toMatchObject({ status: "available" });
    evidence.recordAssertionEvidence("only the length error clears; setup is still available and no account was created", `native validity=${corrected.valid}; bootstrap HTTP ${response.status}; ${JSON.stringify(status)}`, corrected.valid && response.status === 200 && z.object({ status: z.string() }).parse(status).status === "available");
    await user.screenshot();
  });
});
