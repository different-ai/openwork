import { createHmac } from "node:crypto";
import { test } from "@openwork/testkit";
import { expect } from "vitest";

function signedToken(secret: string, payloadValue: unknown) {
  const payload = Buffer.from(JSON.stringify(payloadValue)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`openwork-automation-runner-v1.${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function forgedToken(index: number, audience: string) {
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    o: `fake-org-${String(index)}`,
    m: `fake-member-${String(index)}`,
    r: `fake-runner-${String(index)}`,
    c: [],
    a: audience,
    e: Date.now() + 60_000,
  })).toString("base64url");
  return `${payload}.invalid-signature`;
}

test("rejected Automation runner credentials stay attributable and bounded", async ({ evidence }) => {
  const [{
    AutomationRunnerAuth,
    automationRunnerRejectionLogFields,
  }, {
    AutomationRunnerRejectionLimiter,
    AutomationRunnerRequestAuthenticator,
  }, {
    isAutomationRunnerCredentialRejection,
  }] = await Promise.all([
    import("../../ee/apps/den-api/src/automations/runner-auth.js"),
    import("../../ee/apps/den-api/src/automations/runner-rejection-protection.js"),
    import("../../apps/desktop/electron/automation-runner.mjs"),
  ]);

  const secret = "runner-rejection-test-secret".repeat(3);
  const audience = "https://den.example.com";
  const auth = new AutomationRunnerAuth(secret);
  const issued = auth.issue({
    organizationId: "org_never_log_raw",
    ownerMemberId: "member_never_log_raw",
    runnerId: "runner_never_log_raw",
    capabilities: [],
  }, audience);
  const badSignature = auth.authenticate(`Bearer ${issued.token}x`, audience);
  if (badSignature.ok) throw new Error("expected bad-signature rejection");
  const safeFields = automationRunnerRejectionLogFields(badSignature.rejection);
  expect(safeFields).toMatchObject({
    reason: "bad_signature",
    runner_auth_version: 2,
    claimed_runner_id_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
    claimed_organization_id_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
    claimed_owner_member_id_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
  });
  const serializedFields = JSON.stringify(safeFields);
  for (const value of [
    issued.token,
    secret,
    "org_never_log_raw",
    "member_never_log_raw",
    "runner_never_log_raw",
  ]) expect(serializedFields).not.toContain(value);
  expect(auth.authenticate("Bearer opaque", audience))
    .toMatchObject({ ok: false, rejection: { reason: "malformed_token", claims: {} } });

  const limiter = new AutomationRunnerRejectionLimiter({
    maxFailures: 1,
    windowMs: 60_000,
    maxEntries: 4_096,
    now: () => 10_000,
  });
  const logs: Readonly<Record<string, unknown>>[] = [];
  let ownersActive = false;
  let ownerChecks = 0;
  const authenticator = new AutomationRunnerRequestAuthenticator({
    auth,
    limiter,
    audienceFromRequest: () => audience,
    isActiveOwner: async () => {
      ownerChecks += 1;
      return ownersActive;
    },
    logRejection: (fields) => logs.push(fields),
  });
  const request = (token: string, leadingHop: string) => new Request(
    `${audience}/v1/automation-runner/work`,
    { headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-for": `${leadingHop}, 203.0.113.9`,
      "x-real-ip": leadingHop,
    } },
  );

  const firstForgedToken = forgedToken(0, audience);
  const secondForgedToken = forgedToken(1, audience);
  for (let index = 0; index < 4_097; index += 1) {
    const token = index === 0
      ? firstForgedToken
      : index === 1 ? secondForgedToken : forgedToken(index, audience);
    const result = await authenticator.authenticate(request(token, `attacker-${String(index)}`));
    if (result.ok) throw new Error("expected forged credential rejection");
    if (index === 0) {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("retry-after")).toBeNull();
      expect(await result.response.json()).toEqual({ error: "runner_unauthorized" });
    } else if (index === 1 || index === 4_096) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get("retry-after")).toBe("60");
    }
  }
  expect(limiter.size).toBe(1);
  expect(ownerChecks).toBe(0);
  expect(logs).toHaveLength(2);
  expect(logs.map((entry) => entry.rate_limited)).toEqual([false, true]);
  const serializedLogs = JSON.stringify(logs);
  for (const value of [
    firstForgedToken,
    secondForgedToken,
    "fake-org-0",
    "fake-member-0",
    "fake-runner-0",
    "fake-runner-1",
  ]) expect(serializedLogs).not.toContain(value);

  const signedRunnerA = auth.issue({
    organizationId: "org_signed",
    ownerMemberId: "member_signed",
    runnerId: "signed-runner-a",
    capabilities: [],
  }, audience);
  const signedRunnerB = auth.issue({
    organizationId: "org_signed",
    ownerMemberId: "member_signed",
    runnerId: "signed-runner-b",
    capabilities: [],
  }, audience);
  for (const [index, token] of [signedRunnerA.token, signedRunnerB.token].entries()) {
    const result = await authenticator.authenticate(request(token, `signed-leading-${String(index)}`));
    if (result.ok) throw new Error("expected inactive-owner rejection");
    expect(result.response.status).toBe(401);
  }
  expect(limiter.size).toBe(3);
  expect(ownerChecks).toBe(2);

  expect(auth.authenticate(`Bearer ${signedRunnerA.token}`, "https://other.example.com"))
    .toMatchObject({ ok: false, rejection: { reason: "audience_mismatch" } });
  const legacyExpiresAt = Date.now() + 60_000;
  const legacy = signedToken(secret, {
    v: 1,
    o: "org_legacy",
    m: "member_legacy",
    r: "runner_legacy",
    e: legacyExpiresAt,
  });
  expect(auth.authenticate(`Bearer ${legacy}`, "https://different.example.com"))
    .toMatchObject({ ok: true, identity: { audience: null, expiresAt: legacyExpiresAt } });
  ownersActive = true;
  const valid = await authenticator.authenticate(request(signedRunnerA.token, "fresh-leading-hop"));
  expect(valid).toMatchObject({ ok: true, identity: { runnerId: "signed-runner-a" } });
  expect(limiter.size).toBe(3);

  expect(isAutomationRunnerCredentialRejection({ status: 401 })).toBe(true);
  expect(isAutomationRunnerCredentialRejection({ status: 403 })).toBe(true);
  expect(isAutomationRunnerCredentialRejection({ status: 429, code: "runner_unauthorized" })).toBe(true);
  expect(isAutomationRunnerCredentialRejection({ status: 429, code: "rate_limited" })).toBe(false);
  expect(isAutomationRunnerCredentialRejection({ status: 429 })).toBe(false);

  evidence.recordAssertionEvidence(
    "Runner credential rejections retain safe attribution",
    "Bad-signature claims retain stable fingerprints and version metadata without exposing bearer material, signatures, signing secrets, or raw claimed runner, organization, and member IDs.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Untrusted identities cannot evade the bounded rejection budget",
    "4,097 distinct fake runner IDs and spoofed leading X-Forwarded-For hops from one trusted edge address share one limiter bucket: the first response is 401, later responses are 429 with Retry-After, only the first two decisions log, and signed inactive runners retain separate buckets.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Runner audience and compatibility gates remain intact",
    "A v2 credential fails at a different audience, a signed v1 credential remains audience-less and accepted, and a valid active v2 credential remains usable without consuming rejection state.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Desktop remints only for an authenticated runner rejection",
    "Desktop classifies 401/403 and only a 429 carrying runner_unauthorized as credential rejection; unrelated or unmarked 429 responses remain generic retry failures.",
    true,
  );
});
