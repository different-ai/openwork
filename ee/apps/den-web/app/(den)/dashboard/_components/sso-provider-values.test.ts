import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSamlEntityId, getSsoSetupValues, SsoProviderValues } from "./sso-provider-values";
import { getEmailDomain, getSsoDomainWarning, getSsoRequestError, SsoAdvancedAudience, SsoDomainField, SsoEnableWarning, SsoOidcIssuerHint, SsoSamlNotice } from "./sso-form-guidance";
import { getPasswordPolicyHint, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, MIN_PASSWORD_STRENGTH_SCORE, PASSWORD_COMPOSITION_RULES } from "@openwork/types/den/password-policy";
import { getSetupPasswordError, SetupPasswordField } from "../../setup/password-field";
import { ORGANIZATION_SAML_ALLOW_IDP_INITIATED } from "../../../../../den-api/src/sso-saml-policy";
import { isOrganizationSsoReady } from "../../../../../den-api/src/sso-readiness";
import type { DenOrgSsoConnection } from "../../_lib/den-org";

const connection = {
  id: "example-sso", providerId: "example-provider", kind: "saml", issuer: "https://idp.example.test", domain: "example.test",
  status: "disabled", testStatus: "untested", testExpiresAt: null, signInPath: "/sso/example-workspace",
  signInUrl: "https://ow.ai.example.test/sso/example-workspace",
  redirectUrl: "https://ow.ai.example.test/api/auth/sso/callback/example-provider",
  acsUrl: "https://ow.ai.example.test/api/auth/sso/saml2/sp/acs/example-provider",
  metadataUrl: "https://ow.ai.example.test/api/auth/sso/saml2/sp/metadata?providerId=example-provider",
  domainVerified: true, domainVerificationHost: "_example", domainVerificationDnsName: "_example.example.test",
  oidc: null, saml: { entryPoint: "https://idp.example.test/sso", audience: null, wantAssertionsSigned: true },
  lastTestedAt: null, lastError: null, createdAt: null, updatedAt: null,
} satisfies DenOrgSsoConnection;

function render(saved: DenOrgSsoConnection, copiedValue: string | null = null) {
  return renderToStaticMarkup(createElement(SsoProviderValues, { connection: saved, copiedValue, onCopy: () => {} }));
}

test("saved SAML has four generic rows in order, exact synonym hints and correctly paired values", () => {
  const rows = getSsoSetupValues(connection);
  assert.deepEqual(rows.map(row => row.key), ["entity", "acs", "signin", "metadata"]);
  assert.deepEqual(rows.map(row => row.label), ["Entity ID", "ACS URL (Reply URL)", "Sign-in URL", "Metadata URL"]);
  assert.deepEqual(rows.map(row => row.hint), [
    "Paste it as the app's identifier. Also called Identifier or Audience URI.",
    "Where your identity provider sends users back after sign-in. Also called Single sign-on URL or Assertion Consumer Service URL.",
    "Optional. Some providers ask for it to start sign-in from their app portal (Sign on URL, Initiate login URI).",
    "For identity providers that can import service provider metadata, instead of copying the values one by one.",
  ]);
  assert.deepEqual(rows.map(row => row.value), ["https://ow.ai.example.test", connection.acsUrl, connection.signInUrl, connection.metadataUrl]);
  assert.equal(rows.some(row => row.value === connection.redirectUrl), false);
});

test("SAML setup exposes neither the callback nor a protocol switch, picker or vendor catalog", () => {
  const html = render(connection);
  assert.ok(!html.includes(connection.redirectUrl));
  assert.ok(!html.includes("Redirect URL"));
  assert.doesNotMatch(html, /OIDC|Microsoft|Entra|Okta|combobox|listbox|aria-pressed/);
  assert.equal(html.match(/<button/g)?.length, 4);
  assert.equal(html.match(/aria-label="Copy /g)?.length, 4);
  for (const row of getSsoSetupValues(connection)) assert.ok(html.includes(`aria-label="Copy ${row.label}"`));
});

test("saved OIDC alone exposes the original callback with neutral synonyms, even if stale SAML fields exist", () => {
  const oidc: DenOrgSsoConnection = { ...connection, kind: "oidc" };
  const rows = getSsoSetupValues(oidc);
  assert.deepEqual(rows.map(row => [row.label, row.value]), [["Sign-in URL", connection.signInUrl], ["Redirect URL", connection.redirectUrl]]);
  assert.equal(rows[0].hint, "Optional. Some providers ask for it to start sign-in from their app portal (Sign on URL, Initiate login URI).");
  assert.equal(rows[1].hint, "Where your identity provider sends users back after sign-in. Paste it exactly as the app's redirect URI (Callback URL, Sign-in redirect URI or Authorized redirect URI). It must match character for character.");
  const html = render(oidc);
  assert.ok(html.includes(connection.redirectUrl));
  assert.ok(!html.includes(connection.acsUrl));
  assert.ok(!html.includes(connection.metadataUrl));
  assert.doesNotMatch(html, /Entity ID|ACS URL|Metadata URL|combobox|aria-pressed/);
  assert.equal(html.match(/aria-label="Copy /g)?.length, 2);
  assert.equal(getSamlEntityId(oidc), null);
});

test("persisted custom audience is the Entity ID, never the API callback origin", () => {
  const custom = { ...connection, saml: { entryPoint: null, audience: "https://audience.example.test/tenant", wantAssertionsSigned: true } };
  assert.equal(getSamlEntityId(custom), "https://audience.example.test/tenant");
  assert.equal(getSamlEntityId(connection), "https://ow.ai.example.test");
  assert.notEqual(getSamlEntityId(connection), "https://api-ow.ai.example.test");
});

test("missing or malformed ACS never invents an Entity ID or falls back to the API host", () => {
  assert.equal(getSamlEntityId({ ...connection, acsUrl: null }), null);
  assert.equal(getSamlEntityId({ ...connection, acsUrl: "not-a-url" }), null);
});

test("missing values disable their Copy buttons, while copied feedback stays paired with its row", () => {
  const unavailable = render({ ...connection, acsUrl: null, metadataUrl: null });
  assert.equal(unavailable.match(/disabled=""/g)?.length, 3);
  const copied = render(connection, "acs");
  assert.equal(copied.match(/>Copied</g)?.length, 1);
  const acsButton = copied.match(/<button aria-label="Copy ACS URL \(Reply URL\)"[\s\S]*?<\/button>/)?.[0];
  assert.ok(acsButton?.includes(">Copied<"));
});

test("deriving and rendering setup values never changes the saved connection", () => {
  const before = structuredClone(connection);
  getSsoSetupValues(connection);
  render(connection);
  assert.deepEqual(connection, before);
});

test("setup cards keep the original gray rounded cards, uppercase labels and Copy button styling", () => {
  const html = render(connection);
  assert.ok(html.includes("Give these values to your identity provider"));
  assert.equal(html.match(/rounded-\[20px\] border border-gray-200 bg-gray-50 p-4/g)?.length, 4);
  assert.equal(html.match(/text-\[13px\] font-semibold uppercase tracking-\[0.12em\] text-gray-500/g)?.length, 4);
  assert.equal(html.match(/h-10 px-5/g)?.length, 4);
  assert.ok(!html.includes("divide-y"));
});

test("owner email prefill is normalized and unavailable or malformed email produces no default", () => {
  assert.equal(getEmailDomain(" Admin@Example.Test "), "example.test");
  assert.equal(getEmailDomain(null), null);
  assert.equal(getEmailDomain("missing-domain@"), null);
  assert.equal(getEmailDomain("not-an-email"), null);
  const html = renderToStaticMarkup(createElement(SsoDomainField, { value: "example.test", onChange: () => {}, disabled: false }));
  assert.ok(html.includes("Users&#x27; email domain"));
  assert.ok(html.includes('value="example.test"'));
  assert.ok(html.includes("Not your identity provider"));
  assert.ok(html.includes("w-full rounded-[18px] border border-gray-200 px-4 py-3"));
});

test("domain warning compares available owner/admin emails and does not block saving", () => {
  assert.equal(getSsoDomainWarning("EXAMPLE.TEST", "https://idp.example.test", ["admin@example.test"]), null);
  assert.equal(getSsoDomainWarning("other.test", "https://idp.example.test", ["owner@example.test", "admin@other.test"]), null);
  assert.ok(getSsoDomainWarning("tenant.onmicrosoft.example", "https://idp.example.test", ["admin@example.test"])?.includes("No workspace owner or admin email matches tenant.onmicrosoft.example."));
  assert.equal(getSsoDomainWarning("example.test", "https://idp.example.test", []), null);
  assert.ok(getSsoDomainWarning("tenant.onmicrosoft.com", "https://idp.example.test", [])?.includes("look like identity provider domains"));
  assert.ok(getSsoDomainWarning("idp.example.test", "https://idp.example.test/issuer", [])?.includes("look like identity provider domains"));
  assert.equal(getSsoDomainWarning("example.test", "not-a-url", []), null);
});

test("comma-separated domains are checked individually, trimmed and matched to different admins", () => {
  const admins = ["admin@example.test", "admin@tenant.onmicrosoft.example"];
  assert.equal(getSsoDomainWarning(" EXAMPLE.TEST , tenant.onmicrosoft.example ", "https://idp.example.test", admins), null);
  const warning = getSsoDomainWarning("example.test, tenant.onmicrosoft.example, wrong.test, wrong.test", "https://idp.example.test", admins);
  assert.ok(warning);
  assert.ok(warning.includes("matches wrong.test."));
  assert.ok(!warning.includes("example.test"));
  assert.ok(!warning.includes("tenant.onmicrosoft.example"));
  assert.equal(warning.match(/wrong\.test/g)?.length, 1);
  assert.ok(!warning.includes("was saved"));
  assert.ok(getSsoDomainWarning("example.test,tenant.onmicrosoft.example", "https://idp.example.test", ["admin@example.test"])?.includes("matches tenant.onmicrosoft.example."));
  assert.equal(getSsoDomainWarning(" , , ", "https://idp.example.test", admins), null);
});

test("admin email subdomains match their parent domain, but not siblings, suffix lookalikes or the reverse", () => {
  assert.equal(getSsoDomainWarning("example.com, other.test", "https://idp.example.test", ["owner@eu.example.com", "admin@team.other.test"]), null);
  assert.ok(getSsoDomainWarning("example.com", "https://idp.example.test", ["admin@notexample.com"])?.includes("matches example.com."));
  assert.ok(getSsoDomainWarning("eu.example.com", "https://idp.example.test", ["admin@example.com"])?.includes("matches eu.example.com."));
  assert.ok(getSsoDomainWarning("eu.example.com", "https://idp.example.test", ["admin@us.example.com"])?.includes("matches eu.example.com."));
});

test("without admin data, only suspicious individual entries are named", () => {
  const warning = getSsoDomainWarning("example.test, tenant.onmicrosoft.com, idp.other.test", "https://idp.other.test/issuer", []);
  assert.ok(warning);
  assert.ok(warning.includes("tenant.onmicrosoft.com, idp.other.test"));
  assert.ok(!warning.includes("example.test"));
});

test("Audience URL is in a native collapsed Advanced section and retains its saved value", () => {
  const html = renderToStaticMarkup(createElement(SsoAdvancedAudience, { value: "https://audience.example.test", onChange: () => {}, disabled: false }));
  assert.match(html, /<details[^>]*><summary/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.ok(html.includes("Advanced</summary>"));
  assert.ok(html.includes("Audience URL"));
  assert.ok(html.includes('value="https://audience.example.test"'));
  assert.ok(html.includes("Leave blank to use OpenWork’s Entity ID (shown in the values to give your identity provider)."));
});

test("enable dialog warns that email/password sign-in stops, using the existing dialog text style", () => {
  const html = renderToStaticMarkup(createElement(SsoEnableWarning));
  assert.ok(html.includes("Once enabled, email and password sign-in stops for everyone in this workspace, including you. Keep this admin session open until you have signed in with SSO."));
  assert.ok(html.includes("mt-2 pr-8 text-[14px] leading-6 text-slate-600"));
});

test("SAML notice recommends assertion signing without claiming response-only signatures always fail or forbidding IdP initiation", () => {
  const html = renderToStaticMarkup(createElement(SsoSamlNotice));
  assert.ok(html.includes('We recommend signing SAML assertions with SHA-256.'));
  assert.ok(html.includes('IdP-initiated sign-in for this workspace requires a verified, enabled SSO connection.'));
  assert.doesNotMatch(html, /always requires|SP-initiated responses|response-only.*fail/);
  assert.equal(ORGANIZATION_SAML_ALLOW_IDP_INITIATED, true);
  assert.equal(isOrganizationSsoReady({ connection: { status: 'enabled' }, provider: { domainVerified: true } }), true);
  assert.equal(isOrganizationSsoReady({ connection: { status: 'disabled' }, provider: { domainVerified: true } }), false);
  assert.equal(isOrganizationSsoReady({ connection: { status: 'enabled' }, provider: { domainVerified: false } }), false);
});

test("OIDC issuer guidance distinguishes discovery issuer from authorize and token endpoints", () => {
  const html = renderToStaticMarkup(createElement(SsoOidcIssuerHint));
  assert.ok(html.includes('OpenID configuration (not the authorize or token URL)'));
  assert.ok(html.includes('https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0.'));
  assert.ok(html.includes('mt-1 block text-[12px] text-gray-500'));
});

test("setup password hint states the shared length, composition and strength requirements", () => {
  const html = renderToStaticMarkup(createElement(SetupPasswordField, { value: '', onChange: () => {} }));
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.equal(MAX_PASSWORD_LENGTH, 32);
  assert.match(html, new RegExp(`minlength="${MIN_PASSWORD_LENGTH}"`, 'i'));
  assert.doesNotMatch(html, /maxlength=/i);
  assert.ok(html.includes(getPasswordPolicyHint()));
  for (const rule of Object.values(PASSWORD_COMPOSITION_RULES)) {
    assert.equal(rule.required, true);
    assert.ok(html.includes(rule.hint));
  }
  assert.equal(MIN_PASSWORD_STRENGTH_SCORE, 3);
  assert.ok(html.includes('Avoid common words or patterns; password strength is also checked.'));
  assert.ok(html.includes('aria-describedby="setup-password-policy"'));
  assert.ok(html.includes('class="den-input"'));
});

test("shared composition checks preserve the server's ASCII character classes and punctuation set", () => {
  for (let code = 32; code <= 127; code++) {
    const character = String.fromCharCode(code);
    assert.equal(PASSWORD_COMPOSITION_RULES.uppercase.pattern.test(character), code >= 65 && code <= 90);
    assert.equal(PASSWORD_COMPOSITION_RULES.lowercase.pattern.test(character), code >= 97 && code <= 122);
    assert.equal(PASSWORD_COMPOSITION_RULES.digit.pattern.test(character), code >= 48 && code <= 57);
    assert.equal(PASSWORD_COMPOSITION_RULES.special.pattern.test(character), (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126));
  }
  assert.equal(PASSWORD_COMPOSITION_RULES.uppercase.pattern.test('É'), false);
  assert.equal(PASSWORD_COMPOSITION_RULES.lowercase.pattern.test('é'), false);
  assert.equal(PASSWORD_COMPOSITION_RULES.special.pattern.test('’'), false);
});

test("overlong setup passwords retain all 40 characters and expose an associated inline error, without truncation", () => {
  const value = 'x'.repeat(40);
  const html = renderToStaticMarkup(createElement(SetupPasswordField, { value, onChange: () => {} }));
  assert.ok(html.includes(`value="${value}"`));
  assert.doesNotMatch(html, /maxlength=/i);
  assert.ok(html.includes('aria-invalid="true"'));
  assert.ok(html.includes('aria-describedby="setup-password-policy setup-password-error"'));
  assert.ok(html.includes('id="setup-password-error"'));
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`));
  assert.notEqual(getSetupPasswordError(value), null);
  assert.equal(getSetupPasswordError('x'.repeat(MAX_PASSWORD_LENGTH)), null);
  assert.ok(!renderToStaticMarkup(createElement(SetupPasswordField, { value: 'x'.repeat(MAX_PASSWORD_LENGTH), onChange: () => {} })).includes('id="setup-password-error"'));
});

test("only a single_org_mode 409 receives the sign-out/sign-in recovery text", () => {
  const payload = { error: "single_org_mode", message: "Additional organization changes are disabled." };
  assert.equal(getSsoRequestError(payload, new Response(null, { status: 409 }), "fallback").message, "Additional organization changes are disabled. Sign out and sign back in, then try again.");
  assert.equal(getSsoRequestError(payload, new Response(null, { status: 400 }), "fallback").message, payload.message);
  assert.equal(getSsoRequestError({ error: "other", message: "Another conflict." }, new Response(null, { status: 409 }), "fallback").message, "Another conflict.");
});
