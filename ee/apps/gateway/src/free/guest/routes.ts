import type { Context, Hono } from "hono"
import { FreeAutoBusyError } from "../shared/capacity.js"
import { z } from "zod"
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH,
  DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_SESSION_POW_PATTERN, type DesktopRelease,
  type DesktopFreeAccessStatus, type DesktopFreeVersionError,
} from "@openwork/free-auto"
import { managedModelCatalog } from "@openwork/types/den/inference"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { anonymousIpHash, createAnonymousIdentities, issueAnonymousToken, resolveAnonymousClientAddress, verifyAnonymousToken } from "./identity.js"
import { createFreeAllowanceStore, type FreeAllowanceStore } from "../shared/allowance.js"
import { type AutoConfig } from "../shared/config.js"
import type { GuestPrincipal } from "../shared/principal.js"
import { checkDesktopFreeRequest, desktopFreeGateError, type DesktopFreeGateDependencies } from "./gate.js"
import { sha256Hex, verifySessionPow } from "@openwork/free-auto/node"
import { createDesktopFreeReleaseSource } from "./releases-source.js"
import { dispatchFreeCompletion } from "../shared/dispatch.js"
import { FreeRequestError } from "../shared/errors.js"
import { prepareFreeRequest, readFreeRequest } from "../shared/request.js"
import { env } from "../../env.js"

// The signed proof carries the machine id; the body carries the proof-of-work for this proof's nonce.
const sessionSchema = z.strictObject({ pow: z.string().regex(DESKTOP_FREE_SESSION_POW_PATTERN).optional() })
export type FreeRouteDependencies = {
  config: AutoConfig;
  store: FreeAllowanceStore;
  fetch: typeof fetch;
  releases: () => Promise<DesktopRelease[] | null>;
  now?: () => number;
  clientAddress: (c: Context) => string | null;
}
function defaults(): FreeRouteDependencies {
  const config = env.freeAuto
  return { config, store: createFreeAllowanceStore(config, "anonymous"), fetch: createInferenceEgressFetch(),
    releases: createDesktopFreeReleaseSource({ url: config.releasesUrl, token: process.env.GITHUB_TOKEN?.trim() || undefined }),
    clientAddress: (c) => resolveAnonymousClientAddress(c, config) }
}
function bearer(request: Request) {
  if (["x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.has(name))) return null
  return /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null
}
function errorResponse(error: unknown) {
  if (error instanceof FreeRequestError) return desktopFreeGateError(error.status, error.code, error.message)
  if (error instanceof FreeAutoBusyError) return desktopFreeGateError(error.status, error.code, error.message)
  return desktopFreeGateError(503, "anonymous_unavailable")
}
function versionResponse(error: DesktopFreeVersionError) {
  return Response.json({ error }, { status: error.code === "desktop_update_required" ? 426 : 503, headers: { "cache-control": "no-store" } })
}

/** Signed-out desktop Auto. Signed-in members use their OpenWork Models key on /api/v1 instead. */
export function registerAnonymousInferenceRoutes(app: Hono, dependencies = defaults()) {
  const { config, store } = dependencies
  const gateDependencies: DesktopFreeGateDependencies = { releases: dependencies.releases, consumeNonce: store.consumeNonce, config, now: dependencies.now }
  const route = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { return await handler(c) } catch (error) { return errorResponse(error) }
  }
  app.post(DESKTOP_FREE_SESSION_PATH, route(async (c) => {
    if (!config.anonymousEnabled) return desktopFreeGateError(503, "anonymous_unavailable")
    if (c.req.raw.headers.has("authorization") || new URL(c.req.url).search) return desktopFreeGateError(401, "invalid_anonymous_token")
    const address = dependencies.clientAddress(c)
    if (!address) return desktopFreeGateError(503, "anonymous_unavailable")
    const parsed = await readFreeRequest(c.req.raw, 4096, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]))
    const session = sessionSchema.safeParse(parsed.value)
    if (!session.success) return desktopFreeGateError(400, "invalid_request")
    const gate = await checkDesktopFreeRequest(c.req.raw, parsed.bodyHash, anonymousIpHash(address, config), gateDependencies)
    if (gate.error) return gate.error
    if (gate.versionError) return versionResponse(gate.versionError)
    // Minting costs a little CPU, bound to this proof's single-use nonce so the work cannot be replayed.
    if (!verifySessionPow({ machineId: gate.proof.machineId, nonce: gate.proof.nonce, pow: session.data.pow, bits: config.sessionPowBits, rounds: config.sessionPowRounds })) {
      return Response.json({ error: { code: "session_pow_required", bits: config.sessionPowBits, rounds: config.sessionPowRounds, message: "A proof of work is required to start a guest session." } }, { status: 400, headers: { "cache-control": "no-store" } })
    }
    const identities = createAnonymousIdentities(gate.proof, address, config)
    const minted = await store.consumeSession(identities.ipHash, identities.installationHash)
    if (minted !== "accepted") return desktopFreeGateError(429, minted === "new_identity_capped" ? "anonymous_new_identity_capped" : "anonymous_capacity_exceeded")
    return c.json({ ...issueAnonymousToken(identities, gate.proof, config), model: DESKTOP_FREE_MODEL_ID }, 200, { "cache-control": "no-store" })
  }))

  // Every guest request needs a guest token bound to this IP, plus a fresh signed
  // proof from the same key and machine over the exact method, path, body and token.
  async function authenticate(c: Context, bodyHash: string) {
    if (!config.anonymousEnabled) return { error: desktopFreeGateError(503, "anonymous_unavailable") }
    const token = bearer(c.req.raw)
    const address = dependencies.clientAddress(c)
    const guest = token && address ? verifyAnonymousToken(token, address, config) : null
    if (!guest || !address) return { error: desktopFreeGateError(401, "invalid_anonymous_token") }
    const principal: GuestPrincipal = { kind: "installation", id: guest.installationHash }
    const ipHash = anonymousIpHash(address, config)
    const gate = await checkDesktopFreeRequest(c.req.raw, bodyHash, ipHash, gateDependencies, guest)
    if (gate.error) return { error: gate.error }
    return { ...gate, principal, ipHash }
  }

  app.get(DESKTOP_FREE_STATUS_PATH, route(async (c) => {
    if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
    const auth = await authenticate(c, sha256Hex(""))
    if (auth.error) return auth.error
    const status: DesktopFreeAccessStatus = { state: "unavailable", code: "anonymous_unavailable", currentVersion: auth.proof.appVersion,
      minimumVersion: auth.minimumVersion, providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID,
      allowance: null, catalog: managedModelCatalog(), defaultPinned: true }
    if (auth.versionError) {
      status.state = auth.versionError.code === "desktop_update_required" ? "update_required" : "unavailable"
      status.code = auth.versionError.code
    } else Object.assign(status, await store.read(auth.principal, auth.ipHash))
    return c.json(status, 200, { "cache-control": "no-store" })
  }))
  app.get(DESKTOP_FREE_MODELS_PATH, route(async (c) => {
    if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
    const auth = await authenticate(c, sha256Hex(""))
    if (auth.error) return auth.error
    if (auth.versionError) return versionResponse(auth.versionError)
    return c.json({ object: "list", data: [{ id: DESKTOP_FREE_MODEL_ID, object: "model", created: 0, owned_by: "openwork" }] }, 200, { "cache-control": "no-store" })
  }))
  app.post(DESKTOP_FREE_CHAT_PATH, route(async (c) => {
    if (!config.anonymousEnabled) return desktopFreeGateError(503, "anonymous_unavailable")
    if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
    const deadlineAt = Date.now() + config.requestTimeoutMs
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(config.requestTimeoutMs)])
    const parsed = await readFreeRequest(c.req.raw, config.maxBodyBytes, signal)
    const auth = await authenticate(c, parsed.bodyHash)
    if (auth.error) return auth.error
    if (auth.versionError) return versionResponse(auth.versionError)
    const prepared = prepareFreeRequest(parsed.value, config)
    return dispatchFreeCompletion({ config, store, fetch: dependencies.fetch, principal: auth.principal, ipHash: auth.ipHash,
      prepared, signal, controller, deadlineAt })
  }))
  app.all("/api/anonymous", () => desktopFreeGateError(404, "not_found"))
  app.all("/api/anonymous/*", () => desktopFreeGateError(404, "not_found"))
}
