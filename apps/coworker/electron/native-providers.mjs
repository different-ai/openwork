import { createHash } from "node:crypto";
import {
  customProviderId,
  detectLocalProviders,
  listOpenAiCompatibleModels,
  localServerProviderPatch,
  openAiCompatibleProviderConfig,
} from "./local-providers.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";
const fail = (message) => { throw new Error(message); };
const integrationPath = (id) => `/api/integration/${encodeURIComponent(id)}`;
const attemptPath = (attempt) => `${integrationPath(attempt.integrationID)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}`;
const missingAttempt = () => ({ state: "failed", error: "This sign-in is no longer running.", modelCount: 0 });

/** Only an opaque, app-owned env-store name enters runtime config, never the key. */
export function customProviderKeyName(providerId) {
  return `COWORKER_CUSTOM_${createHash("sha256").update(providerId).digest("hex").toUpperCase()}_API_KEY`;
}

/**
 * beta19086 adapter. engineRequest(method, /api/path, body?, options?) must use
 * the workspace /opencode2 mount and return the native { data } envelope (204:
 * null/undefined). readCatalog must call the current headless v2 readCatalog;
 * its connectedProviderIds, not this adapter, own connected evidence. Keep one
 * adapter per engine/workspace generation so indexes and attempts retain scope.
 *
 * Optional runtime ports are main-process only: patchRuntimeProviders(patch),
 * readRuntimeProviderIds(), storeCustomKey(name, key), removeCustomKey(name).
 * The last two use the server's host-token /env store. Never pass responses,
 * provider settings, keys, or raw transport errors to IPC or a logger.
 */
export function createNativeProviders({
  engineRequest,
  readCatalog,
  patchRuntimeProviders,
  readRuntimeProviderIds,
  storeCustomKey,
  removeCustomKey,
  detect = detectLocalProviders,
  listModels = listOpenAiCompatibleModels,
}) {
  if (typeof engineRequest !== "function" || typeof readCatalog !== "function") fail("Native provider transport and catalog reader are required.");
  const choices = new Map();
  const attempts = new Map();
  const disconnects = new Map();
  const pendingCustomRemovals = new Set();
  let nextIndex = 0;

  async function request(method, route, body, message) {
    try {
      return await engineRequest(method, route, body, { timeoutMs: 20_000 });
    } catch {
      // Provider errors can echo submitted keys, answers or authorization codes.
      fail(message);
    }
  }

  async function snapshot() {
    const [catalog, payload] = await Promise.all([
      readCatalog().catch(() => fail("The AI model catalog could not be read. Try Refresh.")),
      request("GET", "/api/integration", undefined, "Sign-in methods could not be read. Try Refresh."),
    ]);
    const integrations = payload?.data;
    if (!Array.isArray(integrations) || integrations.some((item) => !text(item?.id) || !Array.isArray(item.methods) || !Array.isArray(item.connections))
      || !Array.isArray(catalog?.providers) || !Array.isArray(catalog.models) || !Array.isArray(catalog.connectedProviderIds)) {
      fail("The AI service returned an unsupported provider catalog. Try Refresh.");
    }
    return { ...catalog, integrations };
  }

  function discoveryProviders(catalog) {
    const represented = new Set(catalog.providers.flatMap((provider) => [provider.id, provider.integrationID ?? provider.id]));
    return [...catalog.providers, ...catalog.integrations
      .filter((integration) => !represented.has(integration.id))
      .map(({ id, name }) => ({ id, name, integrationID: id }))];
  }

  function integrationFor(catalog, providerId) {
    const provider = catalog.providers.find((item) => item.id === providerId);
    const integration = catalog.integrations.find((item) => item.id === (provider?.integrationID ?? providerId));
    if (!provider && !integration) fail("That provider is not offered here.");
    return integration;
  }

  function summaries(catalog) {
    return discoveryProviders(catalog).map((provider) => {
      const integration = integrationFor(catalog, provider.id);
      const connections = integration?.connections ?? [];
      const connected = catalog.connectedProviderIds.includes(provider.id);
      return {
        id: provider.id,
        name: text(provider.name) || provider.id,
        integrationID: integration?.id,
        env: [...new Set((integration?.methods ?? []).flatMap((method) => method.type === "env" ? method.names.filter((name) => typeof name === "string") : []))],
        // beta19086 resolves connections[0] as active; saved credentials precede env.
        source: connections[0]?.type === "env" ? "env"
          : connections[0]?.type === "credential" ? "credential"
            : provider.activation === "enabled" ? "config" : "",
        acceptsKey: (integration?.methods ?? []).some((method) => method.type === "key"),
        connected,
        modelCount: connected ? new Set(catalog.models.filter((model) => model.providerID === provider.id && model.enabled).map((model) => model.id)).size : 0,
      };
    });
  }

  const readEngineProviders = async () => summaries(await snapshot());
  const readConnectedProviders = async () => (await readEngineProviders()).filter((provider) => provider.connected);

  function signIns(catalog) {
    return Object.fromEntries(discoveryProviders(catalog).map((provider) => {
      const integration = integrationFor(catalog, provider.id);
      const methods = (integration?.methods ?? []).filter((method) => method.type === "oauth" && text(method.id));
      return [provider.id, methods.map((method) => {
        // Indexes are presentation handles, never offsets into a changing list.
        const identity = JSON.stringify([provider.id, integration.id, method.id]);
        if (!choices.has(identity)) choices.set(identity, nextIndex++);
        return { index: choices.get(identity), label: method.label, integrationID: integration.id, methodID: method.id };
      })];
    }).filter(([, methods]) => methods.length > 0));
  }

  const readEngineSignIns = async () => signIns(await snapshot());

  /** A timeout is unverified, not a successful save/disconnect with zero models. */
  async function waitForProvider(providerId, expectConnected, { timeoutMs = 30_000, pollMs = 750 } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      const provider = (await readConnectedProviders()).find((item) => item.id === providerId);
      if (Boolean(provider) === expectConnected) return provider?.modelCount ?? 0;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    } while (Date.now() <= deadline);
    fail(expectConnected ? "The connection was saved, but model availability is not confirmed. Refresh before trying again."
      : "Removal was requested, but the provider is still available. Refresh to check its other connections.");
  }

  function answerFor(method, answer, integrationID) {
    const result = { ...answer };
    // Preserve the existing public GitHub choice, only for the verified native method.
    if (integrationID === "github-copilot" && method.id === "device" && result.deploymentType === undefined
      && method.form?.some((field) => field.key === "deploymentType" && field.options?.some((option) => option.value === "github.com"))) result.deploymentType = "github.com";
    for (const field of method.form ?? []) {
      if (field.when?.some((condition) => {
        const value = result[condition.key];
        if (value === undefined) return true;
        const equal = Array.isArray(value) ? value.includes(condition.value) : value === condition.value;
        return condition.op === "eq" ? !equal : equal;
      })) continue;
      if (field.type === "external") fail("This connection needs additional setup in OpenCode before it can be used here.");
      if (result[field.key] === undefined && field.default !== undefined) result[field.key] = field.default;
      if (field.required && result[field.key] === undefined) fail("This connection needs additional details. Complete its setup in OpenCode or choose another method.");
    }
    return result;
  }

  /** Keys only. Never accepts a v1 { type: 'api' | 'oauth' } credential. */
  async function storeCredential(providerId, key, { answer, label } = {}) {
    providerId = text(providerId);
    if (!text(key)) fail("Paste the key first.");
    const catalog = await snapshot();
    const integration = integrationFor(catalog, text(providerId));
    const method = integration?.methods.find((item) => item.type === "key");
    if (!method) fail("This provider does not accept a key here. Choose a sign-in instead.");
    await request("POST", `${integrationPath(integration.id)}/connect/key`, {
      key: text(key), answer: answerFor(method, answer, integration.id), ...(text(label) ? { label: text(label) } : {}),
    }, "The key could not be confirmed. Refresh before trying again.");
    return waitForProvider(providerId, true);
  }

  async function startSignIn(providerId, methodIndex, { answer, label, supportsCode = false } = {}) {
    providerId = text(providerId);
    const catalog = await snapshot();
    const methods = signIns(catalog)[text(providerId)] ?? [];
    const chosen = methodIndex === undefined ? methods[0] : methods.find((method) => method.index === methodIndex);
    if (!chosen) fail("That sign-in is no longer offered here. Refresh and choose a sign-in again.");
    const integration = integrationFor(catalog, providerId);
    const method = integration.methods.find((item) => item.id === chosen.methodID && item.type === "oauth");
    const payload = await request("POST", `${integrationPath(chosen.integrationID)}/connect/oauth`, {
      methodID: chosen.methodID, answer: answerFor(method, answer, integration.id), ...(text(label) ? { label: text(label) } : {}),
    }, "The sign-in could not be started. Refresh before trying again.");
    const authorization = payload?.data;
    if (!text(authorization?.attemptID) || !["auto", "code"].includes(authorization.mode)
      || typeof authorization.url !== "string" || typeof authorization.instructions !== "string" || !Number.isFinite(authorization.time?.expires)) fail("The AI service returned an unsupported sign-in attempt.");
    const attempt = { integrationID: chosen.integrationID, methodID: chosen.methodID, attemptID: authorization.attemptID, providerId, mode: authorization.mode, expires: authorization.time.expires };
    attempts.set(attempt.attemptID, attempt);
    if (attempt.mode === "code" && !supportsCode) {
      await cancel(attempt.attemptID);
      fail("This sign-in requires a returned authorization code. Choose a browser or device sign-in, or complete setup in OpenCode.");
    }
    if (authorization.url) {
      let url;
      try { url = new URL(authorization.url); } catch { /* Rejected below. */ }
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        await cancel(attempt.attemptID);
        fail("The AI service returned an unsupported sign-in address.");
      }
    }
    return {
      attemptId: attempt.attemptID, providerId, integrationID: chosen.integrationID, methodID: chosen.methodID,
      mode: attempt.mode, url: authorization.url, instructions: authorization.instructions, label: chosen.label,
      code: attempt.mode === "auto" ? /code:?\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(authorization.instructions)?.[1] ?? "" : "",
    };
  }

  async function completeSignIn(attemptId, code) {
    const attempt = attempts.get(attemptId);
    if (!attempt || attempt.mode !== "code" || !text(code)) fail("Enter the authorization code for the current sign-in.");
    await request("POST", `${attemptPath(attempt)}/complete`, { code: text(code) }, "The authorization code could not be confirmed. Check the sign-in status before trying again.");
    return status(attemptId);
  }

  async function status(attemptId) {
    const attempt = attempts.get(attemptId);
    if (!attempt) return missingAttempt();
    const payload = await request("GET", attemptPath(attempt), undefined, "The sign-in status could not be checked. Try again.");
    if (attempts.get(attemptId) !== attempt) return missingAttempt();
    const state = payload?.data?.status;
    if (state === "pending" && Date.now() < attempt.expires) return { state: "waiting", error: "", modelCount: 0 };
    if (state === "complete") {
      const catalog = await snapshot();
      const provider = summaries(catalog).find((item) => item.id === attempt.providerId && item.connected && item.integrationID === attempt.integrationID && item.source === "credential");
      if (attempts.get(attemptId) !== attempt) return missingAttempt();
      if (provider) return { state: "connected", error: "", modelCount: provider.modelCount };
      return { state: "failed", error: "The sign-in finished, but model availability is not confirmed. Refresh before signing in again.", modelCount: 0 };
    }
    if (["pending", "expired", "failed"].includes(state)) return { state: "failed", error: state === "failed" ? "The sign-in did not finish. Try again." : "The sign-in expired. Try again.", modelCount: 0 };
    fail("The AI service returned an unsupported sign-in status.");
  }

  async function cancel(attemptId) {
    const attempt = attempts.get(attemptId);
    if (!attempt) return { ok: true };
    // Do not forget ownership if cancellation has an uncertain transport result.
    await request("DELETE", attemptPath(attempt), undefined, "Cancellation could not be confirmed. Check the sign-in status.");
    if (attempts.get(attemptId) === attempt) attempts.delete(attemptId);
    return { ok: true };
  }

  async function addCustomProvider({ name, address, key, models }) {
    const label = text(name);
    if (!label) fail("Give the server a name.");
    if (!patchRuntimeProviders || (text(key) && !storeCustomKey)) fail("Custom provider storage is not available here.");
    const listed = await listModels(address, key);
    const wanted = Array.isArray(models) ? models.filter((model) => listed.models.includes(model)) : [];
    const providerId = customProviderId(label);
    const config = openAiCompatibleProviderConfig({ name: label, address: listed.address, models: wanted.length ? wanted : listed.models });
    if (text(key)) {
      const name = customProviderKeyName(providerId);
      try { await storeCustomKey(name, text(key)); } catch { fail("The server key could not be confirmed. Refresh before trying again."); }
      config.env = [name];
    }
    // A failed patch must not roll back a potentially successful key rotation.
    try { await patchRuntimeProviders({ [providerId]: config }); } catch { fail("The server configuration could not be confirmed. Refresh before trying again."); }
    return { status: "connected", providerId, label, modelCount: await waitForProvider(providerId, true) };
  }

  async function connectLocalProvider(id) {
    const { found } = await detect({ providers: await readConnectedProviders() });
    const finding = found.find((item) => item.id === id);
    if (!finding) fail("That is no longer on this Mac. Refresh and try again.");
    if (["codex", "copilot"].includes(finding.kind)) return { status: "failed", providerId: finding.providerId, label: finding.label, error: finding.reason, fallback: "sign-in" };
    if (finding.how === "unavailable") fail(finding.reason);
    if (finding.kind === "server") {
      if (!patchRuntimeProviders) fail("Custom provider storage is not available here.");
      try { await patchRuntimeProviders(localServerProviderPatch(finding)); } catch { fail("The server configuration could not be confirmed. Refresh before trying again."); }
    }
    return { status: "connected", providerId: finding.providerId, label: finding.label, modelCount: await waitForProvider(finding.providerId, true) };
  }

  async function disconnect(providerId, confirmed = false) {
    providerId = text(providerId);
    const catalog = await snapshot();
    const provider = catalog.providers.find((item) => item.id === providerId);
    let runtimeIds = [];
    if (readRuntimeProviderIds) {
      try { runtimeIds = await readRuntimeProviderIds(); } catch { fail("The server configuration could not be read. Try Refresh."); }
    }
    if (runtimeIds.includes(providerId) || pendingCustomRemovals.has(providerId)) {
      if (!patchRuntimeProviders || (providerId.startsWith("custom-") && !removeCustomKey)) fail("Custom provider storage is not available here.");
      try { await patchRuntimeProviders({ [providerId]: null }); } catch { fail("Server removal could not be confirmed. Refresh before trying again."); }
      if (providerId.startsWith("custom-")) {
        pendingCustomRemovals.add(providerId);
        try { await removeCustomKey(customProviderKeyName(providerId)); } catch { fail("The server was removed, but its saved key could not be removed. Retry Disconnect."); }
        pendingCustomRemovals.delete(providerId);
      }
      await waitForProvider(providerId, false);
      return { removed: true, needsConfirmation: false, note: "" };
    }
    if (!provider) fail("That provider is not connected here.");
    const integration = integrationFor(catalog, providerId);
    const credentials = [...new Set((integration?.connections ?? []).filter((item) => item.type === "credential" && text(item.id)).map((item) => item.id))].sort();
    const environment = integration?.connections.some((item) => item.type === "env");
    if (environment && !credentials.length) return { removed: false, needsConfirmation: false, note: "This provider uses your environment. Remove its key there, then restart Open Coworker. Saved sign-ins were not changed." };
    if (!credentials.length) return { removed: false, needsConfirmation: false, note: "There is no saved connection to remove here. Remove this provider from its configuration instead." };
    const identity = JSON.stringify([integration.id, credentials]);
    if (!confirmed || disconnects.get(providerId) !== identity) {
      disconnects.set(providerId, identity);
      return { removed: false, needsConfirmation: true, note: `Remove all saved connections for ${integration.name}? Other providers and apps using this same connection will also lose access.` };
    }
    for (const credentialID of credentials) await request("DELETE", `/api/credential/${encodeURIComponent(credentialID)}`, undefined, "Connection removal could not be confirmed. Refresh before trying again.");
    const refreshed = await snapshot();
    if (refreshed.integrations.some((item) => item.connections.some((connection) => connection.type === "credential" && credentials.includes(connection.id)))) fail("Connection removal is not yet confirmed. Refresh to check.");
    disconnects.delete(providerId);
    const stillConnected = refreshed.connectedProviderIds.includes(providerId);
    return { removed: !stillConnected, needsConfirmation: false, note: stillConnected ? "Saved connections were removed, but another configuration still makes this provider available." : "" };
  }

  return { readEngineProviders, readConnectedProviders, readEngineSignIns, storeCredential, startSignIn, completeSignIn, status, cancel, disconnect, waitForProvider, addCustomProvider, connectLocalProvider };
}
