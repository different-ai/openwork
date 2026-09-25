import type { Context } from "hono"
import { DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, MEMBER_FREE_CHAT_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_STATUS_PATH,
  type DesktopFreeAccessStatus } from "@openwork/free-auto"
import { INFERENCE_FREE_MODEL_ID, managedModelCatalog } from "@openwork/types/den/inference"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { createFreeAllowanceStore, type FreeAllowanceStore } from "../shared/allowance.js"
import { FREE_OPENAI_CHAT_URL, type AutoConfig } from "../shared/config.js"
import { dispatchFreeCompletion } from "../shared/dispatch.js"
import { freeError, FreeRequestError } from "../shared/errors.js"
import { findMemberFreePrincipal, readFreePrincipalDefaultPinned } from "../shared/principal.js"
import { FreeAutoBusyError } from "../shared/capacity.js"
import { prepareFreeRequest, readFreeRequest } from "../shared/request.js"
import type { InferenceKeyRow } from "../../middleware/inference-auth.js"
import { safeInferenceReporter, sentryInferenceReporter, type InferenceReporter } from "../../inference-reporting.js"
import { createRequestLogRecorder, insertRequestLogIntoDb, updateRequestLogInDb, type InsertRequestLog, type UpdateRequestLog } from "../../request-log.js"
import { env } from "../../env.js"

export type FreeMemberDependencies = {
  config: AutoConfig;
  store: FreeAllowanceStore;
  fetch: typeof fetch;
  findMember: typeof findMemberFreePrincipal;
  defaultPinned: typeof readFreePrincipalDefaultPinned;
  usageLog?: { insert: InsertRequestLog; update?: UpdateRequestLog; reporter?: InferenceReporter };
}
function defaults(): FreeMemberDependencies {
  const config = env.freeAuto
  return { config, store: createFreeAllowanceStore(config, "member"), fetch: createInferenceEgressFetch(), findMember: findMemberFreePrincipal,
    defaultPinned: readFreePrincipalDefaultPinned, usageLog: { insert: insertRequestLogIntoDb, update: updateRequestLogInDb } }
}
function disabled() {
  return Response.json({ error: { message: "OpenWork Models are not enabled for this organization.", type: "invalid_request_error", code: "inference_disabled" } },
    { status: 403, headers: { "cache-control": "no-store" } })
}

/**
 * Free Auto for signed-in members of unsubscribed organizations. They call the
 * regular OpenWork Models routes with their `ow_inf_` key; only the free model
 * is served, from the dedicated OpenAI key, within a weekly per-person allowance.
 */
export function createFreeMemberHandler(dependencies: FreeMemberDependencies = defaults()) {
  const { config, store } = dependencies
  return async (c: Context, key: InferenceKeyRow): Promise<Response> => {
    if (!config.memberEnabled) return disabled()
    try {
      const principal = await dependencies.findMember(key)
      if (!principal) return disabled()
      const path = c.req.path, method = c.req.method
      if (new URL(c.req.url).search) return freeError(400, "invalid_request")
      if (method === "GET" && path === MEMBER_FREE_MODELS_PATH) {
        return c.json({ object: "list", data: [{ id: DESKTOP_FREE_MODEL_ID, object: "model", created: 0, owned_by: "openwork" }] }, 200, { "cache-control": "no-store" })
      }
      if (method === "GET" && path === MEMBER_FREE_STATUS_PATH) {
        const status: DesktopFreeAccessStatus = { currentVersion: "", minimumVersion: null, providerID: DESKTOP_FREE_PROVIDER_ID,
          modelID: DESKTOP_FREE_MODEL_ID, catalog: managedModelCatalog(), defaultPinned: await dependencies.defaultPinned(principal), ...await store.read(principal, null) }
        return c.json(status, 200, { "cache-control": "no-store" })
      }
      if (method !== "POST" || path !== MEMBER_FREE_CHAT_PATH) return freeError(404, "not_found", "Only Auto is available without an OpenWork Models subscription.")
      const deadlineAt = Date.now() + config.requestTimeoutMs
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(config.requestTimeoutMs)])
      const parsed = await readFreeRequest(c.req.raw, config.maxBodyBytes, signal)
      const prepared = prepareFreeRequest(parsed.value, config)
      const usageLog = dependencies.usageLog
      const upstream = new URL(FREE_OPENAI_CHAT_URL)
      return dispatchFreeCompletion({ config, store, fetch: dependencies.fetch, principal, ipHash: null, prepared, signal, controller, deadlineAt,
        startUsageLog: usageLog ? (requestId, stream) => {
          const recorder = createRequestLogRecorder({ insertRequestLog: usageLog.insert, updateRequestLog: usageLog.update,
            reporter: safeInferenceReporter(usageLog.reporter ?? sentryInferenceReporter) })
          recorder.start({ identity: { kind: "models", organizationId: key.organization_id, orgMembershipId: key.org_membership_id, inferenceKeyId: key.id },
            openworkRequestId: requestId, route: "openwork_free", protocol: "openai_chat", upstreamProviderId: "openai",
            upstreamHost: upstream.hostname, upstreamPath: upstream.pathname, method: "POST",
            requestedModel: INFERENCE_FREE_MODEL_ID, upstreamModel: INFERENCE_FREE_MODEL_ID, stream, signal })
          return recorder
        } : undefined })
    } catch (error) {
      if (error instanceof FreeRequestError || error instanceof ManagedModelsPolicyError || error instanceof FreeAutoBusyError) return freeError(error.status, error.code, error.message)
      return freeError(503, "free_member_unavailable")
    }
  }
}
export type FreeMemberHandler = ReturnType<typeof createFreeMemberHandler>
