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
 * @typedef {object} MemberCredentialSummary
 * @property {string} orgMembershipId
 * @property {"provisioned"} action
 * @property {string} externalCredentialId
 */

/**
 * @typedef {object} ModelMetadataSummary
 * @property {string} id
 * @property {number} maxInputTokens
 * @property {number} maxOutputTokens
 */

/**
 * @typedef {object} ModelMetadataResult
 * @property {"unchanged" | "updated"} action
 * @property {ModelMetadataSummary[]} models
 */

/**
 * @typedef {object} ReconcileResult
 * @property {ModelMetadataResult} modelMetadata
 * @property {MemberCredentialSummary[]} memberCredentials
 */

/**
 * @typedef {object} CurrentProviderModel
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} config
 */

/**
 * @typedef {object} LiteLlmModelMetadata
 * @property {string} id
 * @property {number} maxInputTokens
 * @property {number} maxOutputTokens
 * @property {Record<string, unknown>} facts
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

/**
 * @param {unknown} value
 * @param {string} label
 */
function requirePositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
  return value;
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
 * @param {ProvisionerConfig} input
 */
function configuredModels(input) {
  const models = [...new Set(input.models.map((model) => requireString(model, "model")))];
  if (models.length === 0) throw new Error("models must contain at least one model id.");
  return models;
}

/**
 * @param {unknown} value
 * @param {string} providerId
 */
function manageableProvider(value, providerId) {
  if (!isRecord(value) || !Array.isArray(value.llmProviders)) {
    throw new Error("Den manageable provider response had an invalid shape.");
  }
  const provider = value.llmProviders.filter(isRecord).find((entry) => entry.id === providerId);
  if (!provider) throw new Error(`Den provider ${providerId} was not found in the manageable provider list.`);
  if (provider.source !== "custom") throw new Error(`Den provider ${providerId} must have source custom.`);
  if (provider.credentialMode !== "per_member") throw new Error(`Den provider ${providerId} must have credentialMode per_member.`);
  return provider;
}

/**
 * @param {Record<string, unknown>} provider
 * @returns {CurrentProviderModel[]}
 */
function currentProviderModels(provider) {
  if (!Array.isArray(provider.models)) throw new Error("Den manageable provider did not include models.");
  return provider.models.map((value) => {
    if (!isRecord(value) || !isRecord(value.config)) {
      throw new Error("Den manageable provider included an invalid model config.");
    }
    return {
      id: requireString(value.id, "Den model id"),
      name: requireString(value.name, `Den model ${String(value.id)} name`),
      config: value.config,
    };
  });
}

/**
 * @param {Record<string, unknown>} provider
 */
function currentProviderAccess(provider) {
  if (!isRecord(provider.access)
    || typeof provider.access.allMembers !== "boolean"
    || !Array.isArray(provider.access.members)
    || !Array.isArray(provider.access.teams)) {
    throw new Error("Den manageable provider did not include a valid access summary.");
  }
  const memberIds = provider.access.members.map((entry) => {
    if (!isRecord(entry)) throw new Error("Den manageable provider included an invalid member access grant.");
    return requireString(entry.orgMembershipId, "Den member access orgMembershipId");
  });
  const teamIds = provider.access.teams.map((entry) => {
    if (!isRecord(entry)) throw new Error("Den manageable provider included an invalid team access grant.");
    return requireString(entry.teamId, "Den team access teamId");
  });
  return {
    allMembers: provider.access.allMembers,
    memberIds: [...new Set(memberIds)].sort(),
    teamIds: [...new Set(teamIds)].sort(),
  };
}

/**
 * @param {unknown} value
 * @param {string[]} models
 * @returns {LiteLlmModelMetadata[]}
 */
function liteLlmModelMetadata(value, models) {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("LiteLLM /model_group/info response had an invalid shape.");
  }
  const entries = value.data.filter(isRecord);
  return models.map((id) => {
    const matches = entries.filter((entry) => entry.model_group === id);
    if (matches.length === 0) {
      throw new Error(`LiteLLM /model_group/info did not include requested model_group ${id}.`);
    }
    if (matches.length > 1) {
      throw new Error(`LiteLLM /model_group/info included duplicate metadata for model_group ${id}.`);
    }
    const facts = matches[0];
    if (!facts) throw new Error(`LiteLLM /model_group/info did not include requested model_group ${id}.`);
    return {
      id,
      maxInputTokens: requirePositiveNumber(
        facts.max_input_tokens,
        `LiteLLM model_group ${id} max_input_tokens`,
      ),
      maxOutputTokens: requirePositiveNumber(
        facts.max_output_tokens,
        `LiteLLM model_group ${id} max_output_tokens`,
      ),
      facts,
    };
  });
}

/**
 * @param {CurrentProviderModel} model
 * @param {LiteLlmModelMetadata | undefined} metadata
 */
function synchronizedModelConfig(model, metadata) {
  if (!metadata) return { ...model.config, id: model.id, name: model.name };
  const currentLimit = isRecord(model.config.limit) ? model.config.limit : {};
  /** @type {Record<string, unknown>} */
  const config = {
    ...model.config,
    id: model.id,
    name: model.name,
    limit: {
      ...currentLimit,
      context: metadata.maxInputTokens,
      input: metadata.maxInputTokens,
      output: metadata.maxOutputTokens,
    },
  };
  if (typeof metadata.facts.supports_function_calling === "boolean") {
    config.tool_call = metadata.facts.supports_function_calling;
  }
  if (typeof metadata.facts.supports_reasoning === "boolean") {
    config.reasoning = metadata.facts.supports_reasoning;
  }
  if (typeof metadata.facts.supports_vision === "boolean") {
    config.attachment = metadata.facts.supports_vision;
  }
  if (typeof metadata.facts.supports_response_schema === "boolean") {
    config.structured_output = metadata.facts.supports_response_schema;
  }
  if (Array.isArray(metadata.facts.supported_openai_params)) {
    config.temperature = metadata.facts.supported_openai_params.includes("temperature");
  }
  return config;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
  );
}

/**
 * Synchronize the configured Den model limits and capability facts from the
 * live LiteLLM model-group metadata endpoint.
 *
 * @param {ProvisionerConfig} input
 * @returns {Promise<ModelMetadataResult>}
 */
export async function syncProviderModelMetadata(input) {
  const denApiUrl = cleanBaseUrl(input.denApiUrl);
  const liteLlmBaseUrl = liteLlmAdminBaseUrl(input.liteLlmBaseUrl);
  const rawProviderId = requireString(input.providerId, "providerId");
  const providerId = encodeURIComponent(rawProviderId);
  const models = configuredModels(input);
  const secrets = [input.denToken, input.liteLlmMasterKey];
  const providerList = await requestJson(
    `${denApiUrl}/v1/llm-providers?scope=manageable`,
    { headers: denHeaders(input) },
    secrets,
  );
  const provider = manageableProvider(providerList, rawProviderId);
  const providerName = requireString(provider.name, "Den provider name");
  if (!isRecord(provider.providerConfig)) {
    throw new Error(`Den provider ${rawProviderId} did not include providerConfig.`);
  }
  const currentModels = currentProviderModels(provider);
  for (const model of models) {
    if (!currentModels.some((current) => current.id === model)) {
      throw new Error(`Den provider ${rawProviderId} does not configure requested model ${model}.`);
    }
  }
  const metadataResponse = await requestJson(
    `${liteLlmBaseUrl}/model_group/info`,
    { headers: { authorization: `Bearer ${input.liteLlmMasterKey}` } },
    secrets,
  );
  const metadata = liteLlmModelMetadata(metadataResponse, models);
  const metadataById = new Map(metadata.map((entry) => [entry.id, entry]));
  const access = currentProviderAccess(provider);
  const currentCustomConfig = {
    ...provider.providerConfig,
    models: currentModels.map((model) => synchronizedModelConfig(model, undefined)),
  };
  const desiredCustomConfig = {
    ...provider.providerConfig,
    models: currentModels.map((model) => synchronizedModelConfig(model, metadataById.get(model.id))),
  };
  const current = {
    name: providerName,
    source: "custom",
    customConfig: currentCustomConfig,
    credentialMode: "per_member",
    ...access,
  };
  const desired = { ...current, customConfig: desiredCustomConfig };
  const summaries = metadata.map((entry) => ({
    id: entry.id,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
  }));
  if (JSON.stringify(canonicalJson(current)) === JSON.stringify(canonicalJson(desired))) {
    return { action: "unchanged", models: summaries };
  }
  await requestJson(
    `${denApiUrl}/v1/llm-providers/${providerId}`,
    {
      method: "PATCH",
      headers: denHeaders(input),
      body: JSON.stringify(desired),
    },
    secrets,
  );
  return { action: "updated", models: summaries };
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
 * @returns {Promise<ReconcileResult>}
 */
export async function reconcileMemberKeys(input) {
  const modelMetadata = await syncProviderModelMetadata(input);
  const denApiUrl = cleanBaseUrl(input.denApiUrl);
  const liteLlmBaseUrl = liteLlmAdminBaseUrl(input.liteLlmBaseUrl);
  const providerId = encodeURIComponent(requireString(input.providerId, "providerId"));
  const models = configuredModels(input);
  const secrets = [input.denToken, input.liteLlmMasterKey];
  const listed = await requestJson(
    `${denApiUrl}/v1/llm-providers/${providerId}/member-credentials`,
    { headers: denHeaders(input) },
    secrets,
  );
  /** @type {MemberCredentialSummary[]} */
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

  return { modelMetadata, memberCredentials: summary };
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
