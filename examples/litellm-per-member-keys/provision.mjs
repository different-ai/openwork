// @ts-check

import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

/**
 * @typedef {object} ProvisionerConfig
 * @property {string} denApiUrl
 * @property {string} denToken
 * @property {string} orgId
 * @property {string} providerId
 * @property {string} liteLlmBaseUrl
 * @property {string} liteLlmMasterKey
 * @property {string[]} models
 * @property {boolean} [dryRun]
 * @property {string} [keyDuration]
 * @property {number} [renewBeforeSeconds]
 */

/**
 * @typedef {object} MemberCredentialSummary
 * @property {string} orgMembershipId
 * @property {"provisioned" | "adopted" | "renewed" | "offboarded" | "stale" | "failed" | "planned"} action
 * @property {"succeeded" | "failed" | "planned"} outcome
 * @property {string} [externalCredentialId]
 * @property {string} [detail]
 */

/**
 * @typedef {object} ModelMetadataSummary
 * @property {string} id
 * @property {number} maxInputTokens
 * @property {number} maxOutputTokens
 */

/**
 * @typedef {object} ModelMetadataResult
 * @property {"unchanged" | "updated" | "planned"} action
 * @property {ModelMetadataSummary[]} models
 */

/**
 * @typedef {object} ReconcileResult
 * @property {ModelMetadataResult} modelMetadata
 * @property {MemberCredentialSummary[]} memberCredentials
 * @property {number} failures
 * @property {number} planned
 * @property {{den: number, liteLlm: number}} writes
 */

/**
 * @typedef {object} LiteLlmKey
 * @property {string} id
 * @property {string | null} alias
 * @property {Record<string, unknown>} metadata
 * @property {boolean} blocked
 */

/** @type {Map<string, Map<string, {externalCredentialId: string, state: string}>>} */
const knownBindingsByProvider = new Map();

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
 * @param {string} action
 * @param {"succeeded" | "failed" | "planned" | "skipped" | "started" | "stopped"} outcome
 * @param {string | undefined} [orgMembershipId]
 * @param {string | undefined} [detail]
 */
function logAction(action, outcome, orgMembershipId, detail) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    action,
    ...(orgMembershipId ? { orgMembershipId } : {}),
    outcome,
    ...(detail ? { detail } : {}),
  }));
}

/** @param {unknown} error @param {string[]} secrets */
function safeError(error, secrets) {
  return redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 1_000);
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

class HttpResponseError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
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
    throw new HttpResponseError(
      redact(`${method} ${pathname} failed with HTTP ${response.status}: ${responseErrorText(body, text).slice(0, 1_000)}`, secrets),
      response.status,
    );
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
    logAction("model_metadata.sync", "skipped", undefined, "already synchronized");
    return { action: "unchanged", models: summaries };
  }
  if (input.dryRun) {
    logAction("model_metadata.sync", "planned", undefined, "Den provider metadata update");
    return { action: "planned", models: summaries };
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
  logAction("model_metadata.sync", "succeeded", undefined, "Den provider metadata updated");
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
 * @param {ProvisionerConfig} input
 */
function liteLlmHeaders(input) {
  return {
    authorization: `Bearer ${input.liteLlmMasterKey}`,
    "content-type": "application/json",
  };
}

/** @param {unknown} value */
function parsedMetadata(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {unknown} value @returns {LiteLlmKey} */
function liteLlmKey(value) {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token) {
    throw new Error("LiteLLM /key/list returned a key without a safe token identifier.");
  }
  return {
    id: value.token,
    alias: typeof value.key_alias === "string" && value.key_alias ? value.key_alias : null,
    metadata: parsedMetadata(value.metadata),
    blocked: value.blocked === true,
  };
}

/** @param {ProvisionerConfig} input */
async function listLiteLlmKeys(input) {
  const baseUrl = liteLlmAdminBaseUrl(input.liteLlmBaseUrl);
  const secrets = [input.denToken, input.liteLlmMasterKey];
  /** @type {LiteLlmKey[]} */
  const keys = [];
  let page = 1;
  let totalPages = 1;
  do {
    const value = await requestJson(
      `${baseUrl}/key/list?return_full_object=true&size=100&page=${page}`,
      { headers: liteLlmHeaders(input) },
      secrets,
    );
    if (!isRecord(value) || !Array.isArray(value.keys)) {
      throw new Error("LiteLLM /key/list response had an invalid shape.");
    }
    keys.push(...value.keys.map(liteLlmKey));
    totalPages = typeof value.total_pages === "number" && Number.isInteger(value.total_pages)
      ? Math.max(1, value.total_pages)
      : 1;
    page += 1;
  } while (page <= totalPages);
  return keys;
}

/** @param {ProvisionerConfig} input */
async function listOrgMemberEmails(input) {
  const denApiUrl = cleanBaseUrl(input.denApiUrl);
  const secrets = [input.denToken, input.liteLlmMasterKey];
  const value = await requestJson(
    `${denApiUrl}/v1/org`,
    { headers: denHeaders(input) },
    secrets,
  );
  if (!isRecord(value) || !Array.isArray(value.members)) {
    throw new Error("Den organization response had an invalid member list.");
  }
  return new Map(value.members.flatMap((member) => {
    if (!isRecord(member)
      || typeof member.id !== "string"
      || !isRecord(member.user)
      || typeof member.user.email !== "string") return [];
    return [[member.id, member.user.email.toLowerCase()]];
  }));
}

/** @param {LiteLlmKey} key */
function managedOrgMembershipId(key) {
  const metadataId = key.metadata.openwork_org_membership_id;
  if (typeof metadataId === "string" && metadataId) return metadataId;
  if (key.alias?.startsWith("openwork-") && !key.alias.includes("-replaced-")) {
    return key.alias.slice("openwork-".length);
  }
  return null;
}

/** @param {LiteLlmKey} key */
function keyMetadataEmail(key) {
  for (const field of ["email", "user_email", "openwork_member_email"]) {
    const value = key.metadata[field];
    if (typeof value === "string" && value) return value.toLowerCase();
  }
  return null;
}

/**
 * @param {LiteLlmKey[]} keys
 * @param {string} orgMembershipId
 * @param {string | undefined} email
 */
function adoptionCandidate(keys, orgMembershipId, email) {
  const alias = `openwork-${orgMembershipId}`;
  const aliasMatches = keys.filter((key) => !key.blocked && key.alias === alias);
  if (aliasMatches.length > 1) throw new Error(`LiteLLM returned multiple active keys for alias ${alias}.`);
  if (aliasMatches[0]) return aliasMatches[0];
  if (!email) return null;
  const emailMatches = keys.filter((key) => {
    const metadataId = managedOrgMembershipId(key);
    return !key.blocked && keyMetadataEmail(key) === email && (!metadataId || metadataId === orgMembershipId);
  });
  if (emailMatches.length > 1) throw new Error(`LiteLLM returned multiple active keys for the member email metadata.`);
  return emailMatches[0] ?? null;
}

/** @param {ProvisionerConfig} input @param {string} credentialId */
async function keyInfo(input, credentialId) {
  const value = await requestJson(
    `${liteLlmAdminBaseUrl(input.liteLlmBaseUrl)}/key/info?key=${encodeURIComponent(credentialId)}`,
    { headers: liteLlmHeaders(input) },
    [input.denToken, input.liteLlmMasterKey],
  );
  if (!isRecord(value) || !isRecord(value.info)) {
    throw new Error("LiteLLM /key/info response had an invalid shape.");
  }
  return value.info;
}

/** @param {unknown} error */
function isUnresolvableKey(error) {
  return error instanceof HttpResponseError && (error.status === 400 || error.status === 404);
}

/**
 * @param {ProvisionerConfig} input
 * @param {string} orgMembershipId
 * @param {string | undefined} email
 * @param {{den: number, liteLlm: number}} writes
 */
async function mintLiteLlmKey(input, orgMembershipId, email, writes) {
  const models = configuredModels(input);
  const value = await requestJson(
    `${liteLlmAdminBaseUrl(input.liteLlmBaseUrl)}/key/generate`,
    {
      method: "POST",
      headers: liteLlmHeaders(input),
      body: JSON.stringify({
        models,
        key_alias: `openwork-${orgMembershipId}`,
        metadata: {
          openwork_org_membership_id: orgMembershipId,
          ...(email ? { email } : {}),
        },
        ...(input.keyDuration ? { duration: requireString(input.keyDuration, "keyDuration") } : {}),
      }),
    },
    [input.denToken, input.liteLlmMasterKey],
  );
  writes.liteLlm += 1;
  return {
    apiKey: generatedKey(value),
    credentialId: externalCredentialId(value),
    userId: isRecord(value) && typeof value.user_id === "string" && value.user_id ? value.user_id : null,
  };
}

/**
 * @param {ProvisionerConfig} input
 * @param {string} orgMembershipId
 * @param {{apiKey: string, credentialId: string, userId: string | null}} minted
 * @param {number | null} expectedVersion
 * @param {{den: number, liteLlm: number}} writes
 */
async function putDenBinding(input, orgMembershipId, minted, expectedVersion, writes) {
  const providerId = encodeURIComponent(requireString(input.providerId, "providerId"));
  await requestJson(
    `${cleanBaseUrl(input.denApiUrl)}/v1/llm-providers/${providerId}/member-credentials/${encodeURIComponent(orgMembershipId)}`,
    {
      method: "PUT",
      headers: denHeaders(input),
      body: JSON.stringify({
        apiKey: minted.apiKey,
        externalCredentialId: minted.credentialId,
        ...(minted.userId ? { externalPrincipalId: minted.userId } : {}),
        ...(expectedVersion === null ? {} : { expectedVersion }),
      }),
    },
    [input.denToken, input.liteLlmMasterKey, minted.apiKey],
  );
  writes.den += 1;
}

/** @param {ProvisionerConfig} input @param {string} credentialId @param {string} alias @param {{den: number, liteLlm: number}} writes */
async function updateLiteLlmAlias(input, credentialId, alias, writes) {
  await requestJson(
    `${liteLlmAdminBaseUrl(input.liteLlmBaseUrl)}/key/update`,
    {
      method: "POST",
      headers: liteLlmHeaders(input),
      body: JSON.stringify({ key: credentialId, key_alias: alias }),
    },
    [input.denToken, input.liteLlmMasterKey],
  );
  writes.liteLlm += 1;
}

/** @param {ProvisionerConfig} input @param {string} credentialId @param {{den: number, liteLlm: number}} writes */
async function deleteLiteLlmKey(input, credentialId, writes) {
  await requestJson(
    `${liteLlmAdminBaseUrl(input.liteLlmBaseUrl)}/key/delete`,
    {
      method: "POST",
      headers: liteLlmHeaders(input),
      body: JSON.stringify({ keys: [credentialId] }),
    },
    [input.denToken, input.liteLlmMasterKey],
  );
  writes.liteLlm += 1;
}

/**
 * LiteLLM v1.97 Community does not expose plaintext virtual keys and gates
 * /key/regenerate behind Enterprise. Preserve the stable alias by moving the
 * old key aside, minting replacement material, switching Den, then deleting
 * the old key. The final upstream key count is unchanged.
 *
 * @param {ProvisionerConfig} input
 * @param {string} orgMembershipId
 * @param {string | undefined} email
 * @param {string} oldCredentialId
 * @param {number | null} expectedVersion
 * @param {{den: number, liteLlm: number}} writes
 */
async function replaceLiteLlmKey(input, orgMembershipId, email, oldCredentialId, expectedVersion, writes) {
  const stableAlias = `openwork-${orgMembershipId}`;
  const replacementAlias = `${stableAlias}-replaced-${randomUUID()}`;
  await updateLiteLlmAlias(input, oldCredentialId, replacementAlias, writes);
  let minted;
  try {
    minted = await mintLiteLlmKey(input, orgMembershipId, email, writes);
  } catch (error) {
    await updateLiteLlmAlias(input, oldCredentialId, stableAlias, writes).catch(() => undefined);
    throw error;
  }
  try {
    await putDenBinding(input, orgMembershipId, minted, expectedVersion, writes);
  } catch (error) {
    await deleteLiteLlmKey(input, minted.credentialId, writes).catch(() => undefined);
    await updateLiteLlmAlias(input, oldCredentialId, stableAlias, writes).catch(() => undefined);
    throw error;
  }
  await deleteLiteLlmKey(input, oldCredentialId, writes);
  return minted;
}

/**
 * @param {ProvisionerConfig} input
 * @param {string} orgMembershipId
 * @param {string | undefined} email
 * @param {{den: number, liteLlm: number}} writes
 */
async function provisionLiteLlmKey(input, orgMembershipId, email, writes) {
  const minted = await mintLiteLlmKey(input, orgMembershipId, email, writes);
  try {
    await putDenBinding(input, orgMembershipId, minted, null, writes);
  } catch (error) {
    await deleteLiteLlmKey(input, minted.credentialId, writes).catch(() => undefined);
    throw error;
  }
  return minted;
}

/** @param {ProvisionerConfig} input */
function providerScope(input) {
  return `${cleanBaseUrl(input.denApiUrl)}|${input.orgId}|${input.providerId}`;
}

/**
 * @param {ProvisionerConfig} input
 * @param {string} orgMembershipId
 * @param {string[]} credentialIds
 * @param {{den: number, liteLlm: number}} writes
 */
async function blockMemberBinding(input, orgMembershipId, credentialIds, writes) {
  for (const credentialId of [...new Set(credentialIds)]) {
    await requestJson(
      `${liteLlmAdminBaseUrl(input.liteLlmBaseUrl)}/key/block`,
      {
        method: "POST",
        headers: liteLlmHeaders(input),
        body: JSON.stringify({ key: credentialId }),
      },
      [input.denToken, input.liteLlmMasterKey],
    );
    writes.liteLlm += 1;
  }
  await requestJson(
    `${cleanBaseUrl(input.denApiUrl)}/v1/llm-providers/${encodeURIComponent(input.providerId)}/member-credentials/${encodeURIComponent(orgMembershipId)}/block`,
    { method: "POST", headers: denHeaders(input), body: JSON.stringify({}) },
    [input.denToken, input.liteLlmMasterKey],
  );
  writes.den += 1;
}

/**
 * Reconcile model metadata, missing bindings, stale upstream references,
 * expiring keys, and members whose provider grant was removed.
 *
 * @param {ProvisionerConfig} input
 * @returns {Promise<ReconcileResult>}
 */
export async function reconcileMemberKeys(input) {
  const modelMetadata = await syncProviderModelMetadata(input);
  const denApiUrl = cleanBaseUrl(input.denApiUrl);
  const providerId = encodeURIComponent(requireString(input.providerId, "providerId"));
  const secrets = [input.denToken, input.liteLlmMasterKey];
  const renewBeforeSeconds = input.renewBeforeSeconds ?? 0;
  if (!Number.isFinite(renewBeforeSeconds) || renewBeforeSeconds < 0) {
    throw new Error("renewBeforeSeconds must be a finite non-negative number.");
  }
  const [listed, emailsByMemberId, upstreamKeys] = await Promise.all([
    requestJson(
      `${denApiUrl}/v1/llm-providers/${providerId}/member-credentials`,
      { headers: denHeaders(input) },
      secrets,
    ),
    listOrgMemberEmails(input),
    listLiteLlmKeys(input),
  ]);
  const entries = memberCredentials(listed).filter((entry) => typeof entry.orgMembershipId === "string");
  const grantedMemberIds = new Set(entries.map((entry) => entry.orgMembershipId));
  const scope = providerScope(input);
  const knownBindings = new Map(knownBindingsByProvider.get(scope) ?? []);
  for (const entry of entries) {
    if (typeof entry.orgMembershipId === "string" && typeof entry.externalCredentialId === "string" && entry.externalCredentialId) {
      knownBindings.set(entry.orgMembershipId, {
        externalCredentialId: entry.externalCredentialId,
        state: typeof entry.state === "string" ? entry.state : "unknown",
      });
    }
  }
  knownBindingsByProvider.set(scope, knownBindings);

  /** @type {MemberCredentialSummary[]} */
  const summary = [];
  const writes = { den: modelMetadata.action === "updated" ? 1 : 0, liteLlm: 0 };
  let failures = 0;
  let planned = modelMetadata.action === "planned" ? 1 : 0;

  /** @type {Map<string, string[]>} */
  const offboardCandidates = new Map();
  for (const [orgMembershipId, binding] of knownBindings) {
    if (!grantedMemberIds.has(orgMembershipId) && binding.state !== "blocked") {
      offboardCandidates.set(orgMembershipId, [binding.externalCredentialId]);
    }
  }
  for (const key of upstreamKeys) {
    const orgMembershipId = managedOrgMembershipId(key);
    if (!orgMembershipId || grantedMemberIds.has(orgMembershipId) || key.blocked) continue;
    const identifiers = offboardCandidates.get(orgMembershipId) ?? [];
    if (!identifiers.includes(key.id)) identifiers.push(key.id);
    offboardCandidates.set(orgMembershipId, identifiers);
  }

  for (const [orgMembershipId, credentialIds] of [...offboardCandidates].sort(([left], [right]) => left.localeCompare(right))) {
    if (input.dryRun) {
      planned += 1;
      summary.push({ orgMembershipId, action: "planned", outcome: "planned", detail: "offboard" });
      logAction("member.offboard", "planned", orgMembershipId, "block LiteLLM before Den");
      continue;
    }
    try {
      await blockMemberBinding(input, orgMembershipId, credentialIds, writes);
      knownBindings.set(orgMembershipId, { externalCredentialId: credentialIds[0], state: "blocked" });
      summary.push({ orgMembershipId, action: "offboarded", outcome: "succeeded", externalCredentialId: credentialIds[0] });
      logAction("member.offboard", "succeeded", orgMembershipId, "LiteLLM blocked before Den");
    } catch (error) {
      failures += 1;
      const detail = safeError(error, secrets);
      summary.push({ orgMembershipId, action: "failed", outcome: "failed", detail });
      logAction("member.offboard", "failed", orgMembershipId, `${detail}; Den binding left active`);
    }
  }

  for (const entry of entries) {
    const orgMembershipId = /** @type {string} */ (entry.orgMembershipId);
    const email = emailsByMemberId.get(orgMembershipId);
    try {
      if (entry.state === "missing") {
        const candidate = adoptionCandidate(upstreamKeys, orgMembershipId, email);
        if (input.dryRun) {
          planned += 1;
          const detail = candidate ? "adopt by alias swap" : "mint missing key";
          summary.push({ orgMembershipId, action: "planned", outcome: "planned", detail });
          logAction(candidate ? "member.adopt" : "member.provision", "planned", orgMembershipId, detail);
          continue;
        }
        const minted = candidate
          ? await replaceLiteLlmKey(input, orgMembershipId, email, candidate.id, null, writes)
          : await provisionLiteLlmKey(input, orgMembershipId, email, writes);
        knownBindings.set(orgMembershipId, { externalCredentialId: minted.credentialId, state: "active" });
        const action = candidate ? "adopted" : "provisioned";
        summary.push({ orgMembershipId, action, outcome: "succeeded", externalCredentialId: minted.credentialId });
        logAction(candidate ? "member.adopt" : "member.provision", "succeeded", orgMembershipId, candidate ? "alias swapped without increasing upstream key count" : "key minted and bound");
        continue;
      }
      if (entry.state === "blocked") continue;
      if (typeof entry.externalCredentialId !== "string" || !entry.externalCredentialId) {
        throw new Error("Den binding did not include externalCredentialId.");
      }
      let info;
      try {
        info = await keyInfo(input, entry.externalCredentialId);
      } catch (error) {
        if (!isUnresolvableKey(error)) throw error;
        if (entry.state === "stale") {
          logAction("member.stale", "skipped", orgMembershipId, "already stale; member self-repair required");
          continue;
        }
        await markStale({ ...input, orgMembershipId });
        if (input.dryRun) {
          planned += 1;
          summary.push({ orgMembershipId, action: "planned", outcome: "planned", detail: "mark stale" });
        } else {
          writes.den += 1;
          knownBindings.set(orgMembershipId, { externalCredentialId: entry.externalCredentialId, state: "stale" });
          summary.push({ orgMembershipId, action: "stale", outcome: "succeeded", externalCredentialId: entry.externalCredentialId });
        }
        // Stale bindings are member-repaired, never automatically re-minted
        // in the same reconciliation pass.
        continue;
      }
      if (entry.state !== "active") continue;
      if (info.expires === null || info.expires === undefined) continue;
      if (typeof info.expires !== "string") throw new Error("LiteLLM /key/info returned an invalid expires value.");
      const expiresAt = Date.parse(info.expires);
      if (!Number.isFinite(expiresAt)) throw new Error("LiteLLM /key/info returned an unparseable expires value.");
      if (expiresAt - Date.now() > renewBeforeSeconds * 1_000) continue;
      if (input.dryRun) {
        planned += 1;
        summary.push({ orgMembershipId, action: "planned", outcome: "planned", detail: "renew expiring key" });
        logAction("member.renew", "planned", orgMembershipId, "key is inside renewal window");
        continue;
      }
      if (typeof entry.version !== "number") throw new Error("Active Den binding did not include a numeric version for renewal.");
      const minted = await replaceLiteLlmKey(
        input,
        orgMembershipId,
        email,
        entry.externalCredentialId,
        entry.version,
        writes,
      );
      knownBindings.set(orgMembershipId, { externalCredentialId: minted.credentialId, state: "active" });
      summary.push({ orgMembershipId, action: "renewed", outcome: "succeeded", externalCredentialId: minted.credentialId });
      logAction("member.renew", "succeeded", orgMembershipId, "replacement stored with expectedVersion");
    } catch (error) {
      failures += 1;
      const detail = safeError(error, secrets);
      summary.push({ orgMembershipId, action: "failed", outcome: "failed", detail });
      logAction("member.reconcile", "failed", orgMembershipId, detail);
    }
  }

  logAction(
    "reconcile.summary",
    failures > 0 ? "failed" : input.dryRun ? "planned" : "succeeded",
    undefined,
    `failures=${failures} planned=${planned} denWrites=${writes.den} liteLlmWrites=${writes.liteLlm}`,
  );
  return { modelMetadata, memberCredentials: summary, failures, planned, writes };
}

/**
 * Block a member's LiteLLM virtual key before marking its Den binding blocked.
 *
 * @param {ProvisionerConfig & { orgMembershipId: string }} input
 * @returns {Promise<{ orgMembershipId: string, action: "blocked" | "planned", externalCredentialId: string }>}
 */
export async function offboardMember(input) {
  const providerId = encodeURIComponent(requireString(input.providerId, "providerId"));
  const orgMembershipId = requireString(input.orgMembershipId, "orgMembershipId");
  const secrets = [input.denToken, input.liteLlmMasterKey];
  const listed = await requestJson(
    `${cleanBaseUrl(input.denApiUrl)}/v1/llm-providers/${providerId}/member-credentials`,
    { headers: denHeaders(input) },
    secrets,
  );
  const binding = memberCredentials(listed).find((entry) => entry.orgMembershipId === orgMembershipId);
  const credentialId = binding && typeof binding.externalCredentialId === "string" ? binding.externalCredentialId : "";
  if (!credentialId) throw new Error(`Member ${orgMembershipId} does not have an externalCredentialId to block.`);
  if (input.dryRun) {
    logAction("member.offboard", "planned", orgMembershipId, "block LiteLLM before Den");
    return { orgMembershipId, action: "planned", externalCredentialId: credentialId };
  }
  await blockMemberBinding(input, orgMembershipId, [credentialId], { den: 0, liteLlm: 0 });
  logAction("member.offboard", "succeeded", orgMembershipId, "LiteLLM blocked before Den");
  return { orgMembershipId, action: "blocked", externalCredentialId: credentialId };
}

/**
 * @param {ProvisionerConfig & {orgMembershipId: string}} input
 * @returns {Promise<{orgMembershipId: string, action: "stale" | "planned"}>}
 */
export async function markStale(input) {
  const orgMembershipId = requireString(input.orgMembershipId, "orgMembershipId");
  if (input.dryRun) {
    logAction("member.stale", "planned", orgMembershipId, "upstream key no longer resolves");
    return { orgMembershipId, action: "planned" };
  }
  await requestJson(
    `${cleanBaseUrl(input.denApiUrl)}/v1/llm-providers/${encodeURIComponent(input.providerId)}/member-credentials/${encodeURIComponent(orgMembershipId)}/stale`,
    { method: "POST", headers: denHeaders(input), body: JSON.stringify({}) },
    [input.denToken, input.liteLlmMasterKey],
  );
  logAction("member.stale", "succeeded", orgMembershipId, "upstream key no longer resolves");
  return { orgMembershipId, action: "stale" };
}

/** @param {string} name */
function env(name) {
  return requireString(process.env[name], name);
}

/** @param {string} name */
function optionalEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** @param {unknown} value @param {string} label */
function nonNegativeNumber(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a finite non-negative number.`);
  return number;
}

/** @param {unknown} value @param {string} label */
function positiveNumber(value, label) {
  const number = nonNegativeNumber(value, label);
  if (number === 0) throw new Error(`${label} must be greater than zero.`);
  return number;
}

/** @param {string | undefined} value */
function booleanValue(value) {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * @typedef {object} CliOptions
 * @property {"reconcile" | "offboard"} command
 * @property {string} [orgMembershipId]
 * @property {boolean} dryRun
 * @property {string} [keyDuration]
 * @property {number} renewBeforeSeconds
 * @property {number} [watchSeconds]
 */

/** @param {string[]} argv @returns {CliOptions} */
function parseCli(argv) {
  const args = [...argv];
  const first = args[0];
  const command = first === "reconcile" || first === "offboard" ? args.shift() : "reconcile";
  if (command !== "reconcile" && command !== "offboard") throw new Error("Unknown command.");
  const orgMembershipId = command === "offboard" ? requireString(args.shift(), "orgMembershipId") : undefined;
  let dryRun = booleanValue(optionalEnv("OPENWORK_DRY_RUN"));
  let keyDuration = optionalEnv("OPENWORK_KEY_DURATION");
  let renewBeforeSeconds = nonNegativeNumber(optionalEnv("OPENWORK_RENEW_BEFORE_SECONDS") ?? 0, "OPENWORK_RENEW_BEFORE_SECONDS");
  /** @type {number | undefined} */
  let watchSeconds;
  while (args.length > 0) {
    const option = args.shift();
    if (option === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (option === "--key-duration") {
      keyDuration = requireString(args.shift(), "--key-duration");
      continue;
    }
    if (option === "--renew-before") {
      renewBeforeSeconds = nonNegativeNumber(args.shift(), "--renew-before");
      continue;
    }
    if (option === "--watch") {
      if (command !== "reconcile") throw new Error("--watch is only valid with reconcile.");
      const next = args[0];
      watchSeconds = next && !next.startsWith("--")
        ? positiveNumber(args.shift(), "--watch")
        : positiveNumber(optionalEnv("OPENWORK_WATCH_SECONDS") ?? 300, "OPENWORK_WATCH_SECONDS");
      continue;
    }
    throw new Error(`Unknown option ${String(option)}.`);
  }
  return { command, ...(orgMembershipId ? { orgMembershipId } : {}), dryRun, ...(keyDuration ? { keyDuration } : {}), renewBeforeSeconds, ...(watchSeconds ? { watchSeconds } : {}) };
}

/** @param {CliOptions} options @returns {ProvisionerConfig} */
function configFromEnv(options) {
  return {
    denApiUrl: env("OPENWORK_DEN_API_URL"),
    denToken: env("OPENWORK_DEN_TOKEN"),
    orgId: env("OPENWORK_ORG_ID"),
    providerId: env("OPENWORK_LLM_PROVIDER_ID"),
    liteLlmBaseUrl: env("LITELLM_BASE_URL"),
    liteLlmMasterKey: env("LITELLM_MASTER_KEY"),
    models: env("LITELLM_MODELS").split(",").map((model) => model.trim()).filter(Boolean),
    dryRun: options.dryRun,
    ...(options.keyDuration ? { keyDuration: options.keyDuration } : {}),
    renewBeforeSeconds: options.renewBeforeSeconds,
  };
}

/** @param {number} milliseconds @param {() => boolean} stopped */
function waitForWatchDelay(milliseconds, stopped) {
  return new Promise((resolve) => {
    if (stopped()) {
      resolve(undefined);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(undefined);
    };
    const timer = setTimeout(finish, milliseconds);
    const poll = setInterval(() => {
      if (stopped()) finish();
    }, 100);
  });
}

/** @param {ProvisionerConfig} config @param {number} watchSeconds */
async function watch(config, watchSeconds) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logAction("watch.lifecycle", "stopped", undefined, "shutdown requested");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  logAction("watch.lifecycle", "started", undefined, `intervalSeconds=${watchSeconds}`);
  try {
    while (!stopping) {
      try {
        await reconcileMemberKeys(config);
      } catch (error) {
        logAction("watch.reconcile", "failed", undefined, safeError(error, [config.denToken, config.liteLlmMasterKey]));
      }
      if (stopping) break;
      const jitteredMilliseconds = watchSeconds * 1_000 * (0.9 + Math.random() * 0.2);
      await waitForWatchDelay(jitteredMilliseconds, () => stopping);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/** @returns {Promise<void>} */
async function main() {
  const options = parseCli(process.argv.slice(2));
  const config = configFromEnv(options);
  if (options.command === "reconcile" && options.watchSeconds) {
    await watch(config, options.watchSeconds);
    return;
  }
  if (options.command === "reconcile") {
    const result = await reconcileMemberKeys(config);
    if (result.failures > 0) process.exitCode = 1;
    return;
  }
  await offboardMember({ ...config, orgMembershipId: requireString(options.orgMembershipId, "orgMembershipId") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      action: "provisioner.fatal",
      outcome: "failed",
      detail: safeError(error, [process.env.OPENWORK_DEN_TOKEN ?? "", process.env.LITELLM_MASTER_KEY ?? ""]),
    }));
    process.exitCode = 1;
  });
}
