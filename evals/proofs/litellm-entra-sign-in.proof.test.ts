import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/library.ts";
import { LITELLM_ENTRA_MODEL_OUTPUT_LIMIT, LITELLM_ENTRA_REPLY, liteLlmEntraSignInWorld } from "../worlds/litellm-entra-sign-in.ts";

// LiteLLM is the real Enterprise proxy (its JWT authentication needs the license); Entra ID is a stand-in.
const test = spec.world(liteLlmEntraSignInWorld, {
  timeout: 900_000,
  needs: { env: ["LITELLM_LICENSE"], commands: ["docker", "openssl"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});
const WITHIN = 60_000;

test("an admin connects a LiteLLM proxy that only takes sign-in tokens, and a member reaches it with their own Microsoft sign-in", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const adminPage = probe.on(world.web);
  const member = user.on(world.memberWeb);
  const issuer = `https://login.microsoftonline.com/${world.setup.tenantId}/v2.0`;

  await step("before: with the feature off, Microsoft sign-in is locked on Add LiteLLM and the API refuses it", async () => {
    await admin.click({ testId: "gateway-provider-pick-litellm" });
    await admin.see({ testId: "gateway-provider-title", text: "Add LiteLLM" }, { timeoutMs: WITHIN });
    await admin.see({ text: /Microsoft sign-in for LiteLLM is turned off for your account/ });
    const refused = await world.addProviderThroughApi();
    const added = await world.provider();
    evidence.recordAssertionEvidence("Nobody can add this kind of provider while the feature is off",
      `POST /v1/inference-providers/litellm with mode "entra" → ${refused.status} ${refused.error}; LiteLLM providers in the organization: ${added ? 1 : 0}`,
      refused.status === 403 && refused.error === "feature_disabled" && added === null);
    expect(refused).toEqual({ status: 403, error: "feature_disabled" });
    expect(added).toBeNull();
    await admin.screenshot();
  });

  await step("the platform admin turns the feature on, and the admin enters the proxy, the Entra app registration, one API scope and the model", async () => {
    await world.setFeature(true);
    await admin.reload();
    await admin.see({ testId: "gateway-provider-title", text: "Add LiteLLM" }, { timeoutMs: WITHIN });
    await admin.notSee({ text: /Microsoft sign-in for LiteLLM is turned off for your account/ });
    await admin.type({ testId: "litellm-base-url" }, world.setup.proxyUrl);
    await admin.click({ role: "radio", text: "Microsoft sign-in" });
    await admin.type({ testId: "litellm-entra-tenant-id" }, world.setup.tenantId);
    await admin.type({ testId: "litellm-entra-client-id" }, world.setup.clientId);
    await admin.type({ testId: "litellm-entra-client-secret" }, world.setup.clientSecret);
    await admin.type({ testId: "litellm-entra-scope" }, world.setup.scope);
    await admin.type({ testId: "litellm-entra-models" }, world.setup.model);
    await admin.see({ testId: "litellm-spend-tracking", text: /LiteLLM budgets each person/ });
    await admin.notSee({ testId: "litellm-api-key" });
    const keyFields = (await adminPage.dom('[data-testid="litellm-api-key"]')).elements.length;
    evidence.recordAssertionEvidence("Microsoft sign-in asks for an app registration, never a LiteLLM key", `LiteLLM key fields on the form: ${keyFields}`, keyFields === 0);
    expect(keyFields).toBe(0);
    await admin.screenshot();
  });

  await step("after: the provider is saved without a LiteLLM key, and its page gives the redirect URI to add to the app registration", async () => {
    await admin.click({ testId: "litellm-connect" });
    await admin.see({ testId: "litellm-entra-redirect-uri" }, { timeoutMs: WITHIN });
    await admin.see({ testId: "litellm-entra-signed-in", text: "0" });
    const redirectUri = (await adminPage.dom('[data-testid="litellm-entra-redirect-uri"]')).elements[0]?.text ?? "";
    world.addRedirectUri(redirectUri);
    const saved = await world.provider();
    const status = isRecord(saved?.litellm) ? saved.litellm : {};
    const facts = { keySource: status.keySource, hasSyncKey: status.hasSyncKey, entraScope: status.entraScope, modelCount: status.modelCount };
    const expected = { keySource: "entra", hasSyncKey: false, entraScope: world.setup.scope, modelCount: 1 };
    evidence.recordAssertionEvidence("OpenWork stores the sign-in settings and holds no LiteLLM key",
      `${JSON.stringify(facts)}; redirect URI ${redirectUri}`, JSON.stringify(facts) === JSON.stringify(expected) && redirectUri.endsWith("/v1/inference-providers/oauth/callback"));
    expect(facts).toEqual(expected);
    expect(redirectUri).toMatch(/\/v1\/inference-providers\/oauth\/callback$/);
    await admin.screenshot();
  });

  await step("before: the member has no models and their request is refused, and Connect offers Microsoft sign-in", async () => {
    const access = await world.access("member");
    const refused = await world.chat("member");
    const reached = world.proxyCalls().length;
    const connect = await world.startConnect("member");
    expect(connect.link).toBeTruthy();
    await member.navigate(connect.link ?? "");
    await member.see({ text: "Sign in to Microsoft" }, { timeoutMs: WITHIN });
    await member.see({ role: "button", label: "Continue to Microsoft" });
    evidence.recordAssertionEvidence("Before signing in the member gets nothing, and LiteLLM is not called",
      `OpenWork says ${access.credentialStatus} with ${access.models} models; chat → ${refused.status} ${refused.error} from ${refused.sentTo}; requests that reached LiteLLM: ${reached}`,
      access.credentialStatus === "member_auth_required" && access.models === 0 && refused.status === 401 && refused.error === "openwork_auth_required" && reached === 0);
    expect(access).toEqual({ credentialStatus: "member_auth_required", models: 0 });
    expect(refused).toMatchObject({ status: 401, error: "openwork_auth_required", sentTo: "gateway" });
    expect(reached).toBe(0);
    await member.screenshot();
  });

  await step("the member continues to Microsoft and picks their work account", async () => {
    await member.click({ role: "button", label: "Continue to Microsoft" });
    await member.see({ testId: "entra-stand-in-banner" }, { timeoutMs: WITHIN });
    await member.see({ text: "Pick an account" });
    await member.screenshot();
    await member.click({ testId: "entra-account-member" });
  });

  await step("after: Microsoft sends the member back, and OpenWork says the provider is connected", async () => {
    await member.see({ text: /is connected to OpenWork/ }, { timeoutMs: WITHIN });
    const exchange = world.signIns().tokenRequests[0];
    const access = await probe.eventually(() => world.access("member"), { within: WITHIN, label: "the member's model is ready", until: (current) => current.models === 1 });
    const wanted = { grantType: "authorization_code", scope: `${world.setup.scope} offline_access openid profile`, clientAuthenticated: true, pkceVerified: true, account: "member", status: 200 };
    evidence.recordAssertionEvidence("OpenWork exchanged the sign-in for a token for the one API scope, with the app's secret and PKCE",
      `grant ${exchange?.grantType}; scope "${exchange?.scope}"; client secret accepted: ${exchange?.clientAuthenticated}; PKCE verified: ${exchange?.pkceVerified}; issued to ${exchange?.account}; HTTP ${exchange?.status}; OpenWork now says ${access.credentialStatus} with ${access.models} model`,
      exchange?.grantType === wanted.grantType && exchange.scope === wanted.scope && exchange.clientAuthenticated && exchange.pkceVerified === true && exchange.account === "member" && exchange.status === 200 && access.models === 1);
    expect(exchange).toEqual(wanted);
    expect(access.models).toBe(1);
    await member.screenshot();
  });

  await step("after: the member's chat request through AI Gateway comes back with LiteLLM's reply", async () => {
    const answered = await world.chat("member");
    evidence.recordAssertionEvidence("A real chat/completions request is answered through AI Gateway and LiteLLM",
      `POST /api/v1/providers/<provider>/chat/completions with the member's OpenWork key → ${answered.status}; reply "${answered.reply}"`,
      answered.status === 200 && answered.reply === LITELLM_ENTRA_REPLY);
    expect(answered).toMatchObject({ status: 200, reply: LITELLM_ENTRA_REPLY, sentTo: "gateway" });
    // The app asks for the output limit OpenWork lists for the model; the model behind LiteLLM refuses more, as OpenAI does.
    const received = (await world.modelRequests()).map((entry) => { try { const body: unknown = JSON.parse(entry.bodyText); return isRecord(body) ? body.max_tokens : undefined; } catch { return undefined; } });
    evidence.recordAssertionEvidence("The member's request asks for no more output than the model supports",
      `OpenWork listed gpt-4o-mini with an output limit; the app asked for max_tokens ${answered.maxTokens}; the model received ${JSON.stringify(received)}; its limit is ${LITELLM_ENTRA_MODEL_OUTPUT_LIMIT}`,
      answered.maxTokens !== undefined && answered.maxTokens <= LITELLM_ENTRA_MODEL_OUTPUT_LIMIT && received.every((value) => typeof value === "number" && value <= LITELLM_ENTRA_MODEL_OUTPUT_LIMIT));
    expect(answered.maxTokens).toBeLessThanOrEqual(LITELLM_ENTRA_MODEL_OUTPUT_LIMIT);
    expect(received).toEqual([answered.maxTokens]);
    await admin.reload();
    await admin.see({ testId: "litellm-entra-signed-in", text: "1" }, { timeoutMs: WITHIN });
    await admin.screenshot();
  });

  await step("then LiteLLM received the member's own Entra token and accepted it by validating the token", async () => {
    const call = world.proxyCalls().filter((entry) => entry.path === "/v1/chat/completions").at(-1);
    const issued = world.signIns().issued.filter((entry) => entry.account === "member").map((entry) => entry.tokenId);
    const proxyUser = await world.proxyUser();
    const reachedModel = (await world.modelRequests()).length;
    const ok = call?.bearer === "token" && call.status === 200 && call.issuer === issuer && call.audience === world.setup.clientId && call.objectId === world.memberObjectId
      && call.tokenId !== null && issued.includes(call.tokenId) && proxyUser.userId === world.memberObjectId && proxyUser.keys === 0 && reachedModel === 1;
    evidence.recordAssertionEvidence("LiteLLM authenticated the member by their token, not by a key",
      `LiteLLM got a signed token (iss ${call?.issuer === issuer ? "the tenant's v2.0 issuer" : call?.issuer}, aud ${call?.audience === world.setup.clientId ? "the app registration" : call?.audience}, oid ${call?.objectId === world.memberObjectId ? "the member" : call?.objectId}, the token issued at sign-in: ${call?.tokenId ? issued.includes(call.tokenId) : false}) and answered ${call?.status}; LiteLLM keys the member holds: ${proxyUser.keys}; requests that reached the model: ${reachedModel}`, ok);
    expect(call).toMatchObject({ bearer: "token", status: 200, issuer, audience: world.setup.clientId, objectId: world.memberObjectId });
    expect(issued).toContain(call?.tokenId);
    expect(proxyUser).toEqual({ userId: world.memberObjectId, keys: 0 });
    expect(reachedModel).toBe(1);
    await admin.see({ testId: "litellm-spend-tracking", text: /LiteLLM budgets each person/ });
  });

  await step("then LiteLLM refuses every request without a valid token for a person it knows", async () => {
    const answers = await world.proxyAnswers();
    const refusedAll = Object.values(answers).every((status) => status === 401);
    evidence.recordAssertionEvidence("No token, a LiteLLM-style key, a forged, misdirected or expired token and an unknown person are all refused by LiteLLM", JSON.stringify(answers), refusedAll);
    expect(answers).toEqual({ noCredential: 401, madeUpKey: 401, tokenFromAnotherSigner: 401, tokenForAnotherAudience: 401, tokenFromAnotherTenant: 401, expiredToken: 401, personUnknownToLiteLlm: 401 });
    expect((await world.modelRequests()).length).toBe(1);
    await admin.see({ testId: "litellm-entra-signed-in", text: "1" });
  });

  await step("a teammate who has not signed in gets no model, and LiteLLM is not called for them", async () => {
    const reachedBefore = world.proxyCalls().length;
    const access = await world.access("teammate");
    const refused = await world.chat("teammate");
    const reachedAfter = world.proxyCalls().length;
    evidence.recordAssertionEvidence("One person's sign-in is not another's",
      `OpenWork tells the teammate ${access.credentialStatus} with ${access.models} models; their chat → ${refused.status} ${refused.error} from ${refused.sentTo}; new requests at LiteLLM: ${reachedAfter - reachedBefore}`,
      access.credentialStatus === "member_auth_required" && access.models === 0 && refused.status === 401 && refused.error === "openwork_auth_required" && reachedAfter === reachedBefore);
    expect(access).toEqual({ credentialStatus: "member_auth_required", models: 0 });
    expect(refused).toMatchObject({ status: 401, error: "openwork_auth_required", sentTo: "gateway" });
    expect(reachedAfter).toBe(reachedBefore);
    await admin.see({ testId: "litellm-entra-signed-in", text: "1" });
  });

  await step("after the feature is turned off again, the signed-in member is refused before LiteLLM, and nobody can connect", async () => {
    // A Connect page the member opened while the feature was still on.
    const opened = await world.startConnect("member");
    await world.setFeature(false);
    const reachedBefore = world.proxyCalls().length;
    const refused = await probe.eventually(() => world.chat("member"), { within: WITHIN, label: "the member's request is refused", until: (answer) => answer.status !== 200 });
    const access = await world.access("member");
    const connect = await world.startConnect("member");
    const reachedAfter = world.proxyCalls().length;
    await member.navigate(opened.link ?? "");
    await member.see({ text: "Sign-in unavailable" }, { timeoutMs: WITHIN });
    await member.notSee({ role: "button", label: "Continue to Microsoft" });
    await admin.reload();
    await admin.see({ text: /Read only\. Microsoft sign-in for LiteLLM is turned off for your account/ }, { timeoutMs: WITHIN });
    evidence.recordAssertionEvidence("Turning the feature off stops the mode, including for a person who already signed in",
      `chat → ${refused.status} ${refused.error} from ${refused.sentTo}; OpenWork lists ${access.models} models for the member; selecting Connect → ${connect.status} ${connect.error}; new requests at LiteLLM: ${reachedAfter - reachedBefore}`,
      refused.status === 403 && refused.error === "feature_disabled" && access.models === 0 && connect.status === 403 && connect.error === "feature_disabled" && reachedAfter === reachedBefore);
    expect(opened.link).toBeTruthy();
    expect(refused).toMatchObject({ status: 403, error: "feature_disabled", sentTo: "gateway" });
    expect(access.models).toBe(0);
    expect(connect).toEqual({ status: 403, error: "feature_disabled", link: null });
    expect(reachedAfter).toBe(reachedBefore);
    await member.screenshot();
    await admin.screenshot();
  });
});
