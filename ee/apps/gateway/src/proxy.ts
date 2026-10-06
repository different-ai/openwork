import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { GATEWAY_BEARER_KEY_PREFIX } from "@openwork-ee/utils/gateway-bearer-key"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import type { findActiveGatewayKey, findActiveInferenceKey as findActiveInferenceKeyFn } from "./keys.js"
import { sentryInferenceReporter, safeInferenceReporter } from "./inference-reporting.js"
import type { InferenceReporter } from "./inference-reporting.js"
import { inferenceAuth, readOpenWorkKey } from "./middleware/inference-auth.js"
import { gatewayAuth } from "./middleware/gateway-auth.js"
import type { InferenceAuthEnv } from "./middleware/inference-auth.js"
import { loadOrganizationFromDb, orgContext } from "./middleware/org-context.js"
import type { LoadOrganization } from "./middleware/org-context.js"
import { gatewayModelEndpoints, gatewayModelsPath, registerGatewayRoutes } from "./gateway.js"
import type { GatewayDependencies } from "./gateway.js"
import { insertRequestLogIntoDb } from "./request-log.js"
import type { InsertRequestLog } from "./request-log.js"
import type { FreeMemberHandler } from "./free/member/handler.js"
import type { InferenceEnv } from "./inference-http.js"
import { handleInferenceKeyRequest } from "./inference-key-dispatch.js"
import { createOpenWorkModelsHandler } from "./openwork-models/handler.js"
import type { OpenWorkModelsDependencies } from "./openwork-models/handler.js"

export type { InferenceEnv } from "./inference-http.js"

/**
 * Paths shared with OpenWork Models: GET /api/v1/models and the provider-less POST endpoints.
 * An ow_gw_ key there is handled by Gateway; any other key stays on OpenWork Models.
 */
function isSharedGatewayRequest(request: Request, path: string) {
  const shared = (request.method === "GET" && path === gatewayModelsPath)
    || (request.method === "POST" && Object.hasOwn(gatewayModelEndpoints, path))
  if (!shared) return false
  try {
    return readOpenWorkKey(request)?.startsWith(GATEWAY_BEARER_KEY_PREFIX) === true
  } catch {
    // Conflicting credentials are rejected by the Models authenticator.
    return false
  }
}

const defaultProxyDependencies: ProxyDependencies = {
  async findActiveInferenceKey(key) {
    const keys = await import("./keys.js")
    return keys.findActiveInferenceKey(key)
  },
  async assertOrganizationManagedModelsAllowed(organizationId) {
    const keys = await import("./keys.js")
    return keys.assertOrganizationManagedModelsAllowed(organizationId)
  },
  async getOpenRouterProviderKey(organizationId) {
    const { getOpenRouterProviderKey } = await import("./openwork-models/openrouter-key.js")
    return getOpenRouterProviderKey(organizationId)
  },
  async ensureUsableBuckets(organizationId) {
    const limits = await import("./openwork-models/limits.js")
    return limits.ensureUsableBuckets(organizationId)
  },
  fetch: createInferenceEgressFetch(),
  async analytics(input) {
    const { beginModelAnalytics } = await import("./task-analytics.js")
    return beginModelAnalytics(input)
  },
  loadOrganization: loadOrganizationFromDb,
  insertRequestLog: insertRequestLogIntoDb,
  async freeMember(c, key) {
    const { createFreeMemberHandler } = await import("./free/member/handler.js")
    freeMemberHandler ??= createFreeMemberHandler()
    return freeMemberHandler(c, key)
  },
}
let freeMemberHandler: FreeMemberHandler | undefined

type ProxyDependencies = OpenWorkModelsDependencies & {
  findActiveGatewayKey?: typeof findActiveGatewayKey
  findActiveInferenceKey: typeof findActiveInferenceKeyFn
  loadOrganization?: LoadOrganization
  insertRequestLog?: InsertRequestLog
  reporter?: InferenceReporter
  gateway?: Partial<GatewayDependencies>
  /** Serves free Auto to members of organizations without an OpenWork Models subscription. */
  freeMember?: FreeMemberHandler
}

export function registerProxyRoutes(app: Hono, dependencies: ProxyDependencies = defaultProxyDependencies) {
  const reporter = safeInferenceReporter(dependencies.reporter ?? sentryInferenceReporter)
  const insertRequestLog = dependencies.insertRequestLog ?? insertRequestLogIntoDb
  const api = new Hono<InferenceEnv>()
  const models = createOpenWorkModelsHandler({ dependencies, reporter, insertRequestLog })

  const authenticateModels = inferenceAuth({ findActiveInferenceKey: dependencies.findActiveInferenceKey })
  const authenticateGateway = gatewayAuth({ findActiveGatewayKey: dependencies.findActiveGatewayKey ?? (async (key) => (await import("./keys.js")).findActiveGatewayKey(key)) })
  api.use("/api/v1/*", createMiddleware<InferenceAuthEnv>((c, next) => c.req.path.startsWith("/api/v1/providers/") || isSharedGatewayRequest(c.req.raw, c.req.path)
    ? authenticateGateway(c, next) : authenticateModels(c, next)))
  api.use("/api/v1/*", orgContext({ loadOrganization: dependencies.loadOrganization ?? loadOrganizationFromDb }))
  registerGatewayRoutes(api, { fetch: dependencies.fetch, insertRequestLog, updateRequestLog: dependencies.updateRequestLog, reporter, ...dependencies.gateway })
  for (const path of ["/api/v1", "/api/v1/*"]) {
    api.all(path, (c) => handleInferenceKeyRequest(c, { freeMember: dependencies.freeMember, models }))
  }
  app.route("/", api)
}
