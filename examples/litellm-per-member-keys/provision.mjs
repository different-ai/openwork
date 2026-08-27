// @ts-check

import { pathToFileURL } from "node:url";

/**
 * @typedef {object} ProvisionerConfig
 * @property {string} denApiUrl
 * @property {string} denToken
 * @property {string} orgId
 * @property {string} providerId
 * @property {string} liteLlmBaseUrl
 * @property {string} liteLlmMasterKey
 * @property {string[]} models
 */

/**
 * @typedef {object} ReconcileSummary
 * @property {string} orgMembershipId
 * @property {"provisioned"} action
 * @property {string} externalCredentialId
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

/** @param {unknown} value */
function cleanBaseUrl(value) {
  return requireString(value, "Base URL").replace(/\/+$/, "");
}

/** @param {unknown} value */
function liteLlmAdminBaseUrl(value) {
  return cleanBaseUrl(value).replace(/\/v1$/, "");
}

/**
 * @param {string} text
 * @param {string[]} secrets
 */
function redact(text, secrets) {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

/**
 * @param {unknown} body
 * @param {string} text
 */
function responseErrorText(body, text) {
  if (isRecord(body)) {
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  }
  return text || "empty response";
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {string[]} secrets
 * @returns {Promise<unknown>}
 */
async function requestJson(url, init, secrets) {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  const text = await response.text();
  /** @type {unknown} */
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const method = init.method ?? "GET";
    const pathname = new URL(url).pathname;
    throw new Error(redact(`${method} ${pathname} failed with HTTP ${response.status}: ${responseErrorText(body, text).slice(0, 1_000)}`, secrets));
  }
  return body;
}

/** @param {ProvisionerConfig} input */
function denHeaders(input) {
  return {
    authorization: `Bearer ${input.denToken}`,
    "content-type": "application/json",
    "x-openwork-org-id": input.orgId,
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function memberCredentials(value) {
  if (!isRecord(value) || !Array.isArray(value.memberCredentials)) {
    throw new Error("Den member-credentials response had an invalid shape.");
  }
  return value.memberCredentials.filter(isRecord);
}

/** @param {unknown} value */
function generatedKey(value) {
  if (!isRecord(value) || typeof value.key !== "string" || !value.key) {
    throw new Error("LiteLLM key generation response did not include a key.");
  }
  return value.key;
}

/**
 * @param {unknown} value
 */
function externalCredentialId(value) {
  if (isRecord(value) && typeof value.token_id === "string" && value.token_id) return value.token_id;
  throw new Error("LiteLLM key generation response did not include token_id; refusing to persist an unsafe credential identifier.");
}

/**
 * Mint a LiteLLM virtual key for every granted Den member whose binding is missing.
 *
 * @param {ProvisionerConfig} input
 * @returns {Promise<ReconcileSummary[]>}
 */
export async function reconcileMemberKeys(input) {
  const denApiUrl = cleanBaseUrl(input.denApiUrl);
  const liteLlmBaseUrl = liteLlmAdminBaseUrl(input.liteLlmBaseUrl);
  const providerId = encodeURIComponent(requireString(input.providerId, "providerId"));
  const models = input.models.map((model) => requireString(model, "model"));
  if (models.length === 0) throw new Error("models must contain at least one model id.");
  const secrets = [input.denToken, input.liteLlmMasterKey];
  const listed = await requestJson(
    `${denApiUrl}/v1/llm-providers/${providerId}/member-credentials`,
    { headers: denHeaders(input) },
    secrets,
  );
  /** @type {ReconcileSummary[]} */
  const summary = [];

  for (const entry of memberCredentials(listed)) {
    if (entry.state !== "missing" || typeof entry.orgMembershipId !== "string") continue;
    const orgMembershipId = entry.orgMembershipId;
    const keyAlias = `openwork-${orgMembershipId}`;
    const generated = await requestJson(
      `${liteLlmBaseUrl}/key/generate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.liteLlmMasterKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          models,
          key_alias: keyAlias,
          metadata: { openwork_org_membership_id: orgMembershipId },
        }),
      },
      secrets,
    );
    const apiKey = generatedKey(generated);
    const credentialId = externalCredentialId(generated);
    const userId = isRecord(generated) && typeof generated.user_id === "string" && generated.user_id
      ? generated.user_id
      : null;
    const body = {
      apiKey,
      externalCredentialId: credentialId,
      ...(userId ? { externalPrincipalId: userId } : {}),
    };
    await requestJson(
      `${denApiUrl}/v1/llm-providers/${providerId}/member-credentials/${encodeURIComponent(orgMembershipId)}`,
      { method: "PUT", headers: denHeaders(input), body: JSON.stringify(body) },
      [...secrets, apiKey],
    );
    summary.push({ orgMembershipId, action: "provisioned", externalCredentialId: credentialId });
  }

  return summary;
}

/**
 * Block a member's LiteLLM virtual key before marking its Den binding blocked.
 * LiteLLM v1.97 accepts the generated token_id in POST /key/block, so plaintext
 * member keys are not needed after reconciliation.
 *
 * @param {ProvisionerConfig & { orgMembershipId: string }} input
 * @returns {Promise<{ orgMembershipId: string, action: "blocked", externalCredentialId: string }>}
 */
export async function offboardMember(input) {
  const denApiUrl = cleanBaseUrl(input.denApiUrl);
  const liteLlmBaseUrl = liteLlmAdminBaseUrl(input.liteLlmBaseUrl);
  const providerId = encodeURIComponent(requireString(input.providerId, "providerId"));
  const orgMembershipId = requireString(input.orgMembershipId, "orgMembershipId");
  const secrets = [input.denToken, input.liteLlmMasterKey];
  const listed = await requestJson(
    `${denApiUrl}/v1/llm-providers/${providerId}/member-credentials`,
    { headers: denHeaders(input) },
    secrets,
  );
  const binding = memberCredentials(listed).find((entry) => entry.orgMembershipId === orgMembershipId);
  const credentialId = binding && typeof binding.externalCredentialId === "string"
    ? binding.externalCredentialId
    : "";
  if (!credentialId) {
    throw new Error(`Member ${orgMembershipId} does not have an externalCredentialId to block.`);
  }

  await requestJson(
    `${liteLlmBaseUrl}/key/block`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.liteLlmMasterKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: credentialId }),
    },
    secrets,
  );
  await requestJson(
    `${denApiUrl}/v1/llm-providers/${providerId}/member-credentials/${encodeURIComponent(orgMembershipId)}/block`,
    { method: "POST", headers: denHeaders(input), body: JSON.stringify({}) },
    secrets,
  );
  return { orgMembershipId, action: "blocked", externalCredentialId: credentialId };
}

/** @param {string} name */
function env(name) {
  return requireString(process.env[name], name);
}

/** @returns {ProvisionerConfig} */
function configFromEnv() {
  return {
    denApiUrl: env("OPENWORK_DEN_API_URL"),
    denToken: env("OPENWORK_DEN_TOKEN"),
    orgId: env("OPENWORK_ORG_ID"),
    providerId: env("OPENWORK_LLM_PROVIDER_ID"),
    liteLlmBaseUrl: env("LITELLM_BASE_URL"),
    liteLlmMasterKey: env("LITELLM_MASTER_KEY"),
    models: env("LITELLM_MODELS").split(",").map((model) => model.trim()).filter(Boolean),
  };
}

/** @returns {Promise<void>} */
async function main() {
  const command = process.argv[2];
  const config = configFromEnv();
  if (command === "reconcile") {
    console.log(JSON.stringify(await reconcileMemberKeys(config), null, 2));
    return;
  }
  if (command === "offboard") {
    const orgMembershipId = requireString(process.argv[3], "orgMembershipId");
    console.log(JSON.stringify(await offboardMember({ ...config, orgMembershipId }), null, 2));
    return;
  }
  throw new Error("Usage: node provision.mjs reconcile | node provision.mjs offboard <orgMembershipId>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
