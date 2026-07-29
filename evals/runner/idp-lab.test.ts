import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBlockedUserResponse,
  buildOidcClaims,
  buildRs256SigningArgv,
  buildWrongDomainEmail,
  matchSsoExpectation,
  normalizeCertificateMaterial,
  normalizeDomain,
  normalizeMockIdpConfig,
  subjectWithKnobs,
  validateSsoConfiguration,
} from "./labs/idp.ts";

test("mock IdP config normalization trims issuer, domain, and credentials", () => {
  const config = normalizeMockIdpConfig({
    issuer: " https://idp.example.test/ ",
    domain: " @Acme.TEST. ",
    clientId: " client-one ",
    clientSecret: " secret-one ",
  });

  assert.equal(config.issuer, "https://idp.example.test");
  assert.equal(config.domain, "acme.test");
  assert.equal(config.clientId, "client-one");
  assert.equal(config.clientSecret, "secret-one");
  assert.equal(config.defaultSubject.email, "sso.user@acme.test");
});

test("certificate normalizer names the trailing-newline paste bug", () => {
  const cert = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";
  const normalized = normalizeCertificateMaterial(cert);
  const validation = validateSsoConfiguration({ configuredDomain: "acme.test", cert, subjectEmail: "maya@acme.test" });
  const match = matchSsoExpectation(validation, { code: "sso_cert_trailing_newline", includes: ["trailing newline", "certificate"] });

  assert.equal(normalized.hadTrailingNewline, true);
  assert.equal(normalized.value.endsWith("\n"), false);
  assert.equal(validation.ok, false);
  assert.equal(match.passed, true);
});

test("domain mismatch normalizer names IdP email domains that do not match the org", () => {
  const wrongEmail = buildWrongDomainEmail("maya@acme.test", "acme.test");
  const validation = validateSsoConfiguration({ configuredDomain: "ACME.test", subjectEmail: wrongEmail });
  const match = matchSsoExpectation(validation, { code: "sso_domain_mismatch", includes: ["wrong-acme.test", "acme.test"] });

  assert.equal(wrongEmail, "maya@wrong-acme.test");
  assert.equal(normalizeDomain(" @ACME.test. "), "acme.test");
  assert.equal(validation.normalizedDomain, "acme.test");
  assert.equal(match.passed, true);
});

test("claim builder supports present, absent, and unexpected group claim shapes", () => {
  const baseConfig = normalizeMockIdpConfig({ domain: "acme.test" });
  const subject = subjectWithKnobs(baseConfig, { email: "dev@acme.test", name: "Dev User" });
  const present = buildOidcClaims({ issuer: baseConfig.issuer, clientId: baseConfig.clientId, subject, knobs: baseConfig.knobs });
  const absentConfig = normalizeMockIdpConfig({ knobs: { groupClaims: "absent" } });
  const absent = buildOidcClaims({ issuer: absentConfig.issuer, clientId: absentConfig.clientId, subject, knobs: absentConfig.knobs });
  const oddConfig = normalizeMockIdpConfig({ knobs: { groupClaims: "unexpected-shape" } });
  const odd = buildOidcClaims({ issuer: oddConfig.issuer, clientId: oddConfig.clientId, subject, knobs: oddConfig.knobs });

  assert.deepEqual(present.groups, ["Engineering", "OpenWork Lab"]);
  assert.equal("groups" in absent, false);
  assert.deepEqual(odd.groups, { primary: "Engineering", all: ["Engineering", "OpenWork Lab"] });
});

test("email mismatch and guest-user knobs shape SSO subjects", () => {
  const mismatchConfig = normalizeMockIdpConfig({ knobs: { emailMismatch: "other@acme.test" } });
  const guestConfig = normalizeMockIdpConfig({ knobs: { guestUser: true } });

  assert.equal(subjectWithKnobs(mismatchConfig, { email: "invited@acme.test" }).email, "other@acme.test");
  assert.equal(subjectWithKnobs(guestConfig, { email: "guest@external.test" }).sub, "guest:guest@external.test");
});

test("RS256 signing argv documents the dependency-free node:crypto path", () => {
  assert.deepEqual(buildRs256SigningArgv({ keyId: "kid-one", payload: "abc" }), [
    "node:crypto",
    "createSign",
    "RSA-SHA256",
    "--kid",
    "kid-one",
    "--payload-bytes",
    "3",
  ]);
});

test("blocked-user response uses the Entra-style policy wording", () => {
  const response = buildBlockedUserResponse({ email: "blocked@acme.test" });

  assert.equal(response.status, 403);
  assert.equal(response.error, "access_denied");
  assert.match(response.errorDescription, /administrator has configured the application to block users/);
  assert.match(response.message, /IdP administrator/);
  assert.match(response.html, /OpenWork Mock IdP policy/);
});

test("expectation matcher fails with actionable detail when the named error is missing", () => {
  const validation = validateSsoConfiguration({ configuredDomain: "acme.test", subjectEmail: "maya@acme.test" });
  const match = matchSsoExpectation(validation, { code: "sso_domain_mismatch" });

  assert.equal(match.passed, false);
  assert.deepEqual(match.actualCodes, []);
  assert.match(match.detail, /Expected sso_domain_mismatch/);
});
