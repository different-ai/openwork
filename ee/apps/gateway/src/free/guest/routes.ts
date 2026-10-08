import type { Context, Hono } from "hono"
import { FreeAutoBusyError } from "../shared/capacity.js"
import { z } from "zod"
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH,
  DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_RESPONSES_PATH, DESKTOP_FREE_SESSION_POW_PATTERN, DESKTOP_FREE_PROOF_HEADER, DESKTOP_FREE_OPEN_API_KEY,
  type DesktopFreeAccessStatus, type DesktopFreeVersionError,
} from "@openwork/free-auto"
import { managedModelCatalog } from "@openwork/types/den/inference"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { anonymousIpHash, createAnonymousIdentities, issueAnonymousToken, resolveAnonymousClientAddress, verifyAnonymousToken } from "./identity.js"
import { createFreeAllowanceStore, type FreeAllowanceStore } from "../shared/allowance.js"
import { untaggedAutoEnabled, type AutoConfig } from "../shared/config.js"
import { freeIdentityHash, type GuestPrincipal } from "../shared/principal.js"
import { checkDesktopFreeRequest, desktopFreeGateError, type DesktopFreeGateDependencies } from "./gate.js"
import { releaseKeyFingerprint, sha256Hex, verifySessionPow } from "@openwork/free-auto/node"
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
  now?: () => number;
  clientAddress: (c: Context) => string | null;
}
function defaults(): FreeRouteDependencies {
  const config = env.freeAuto
  // Compare with the fingerprint the desktop release build prints; a mismatch means every guest on that release is refused.
  if (config.releaseKey) console.info(`[free-auto] release key fingerprint ${releaseKeyFingerprint(config.releaseKey)}${config.releaseKeyPrevious ? `, previous ${releaseKeyFingerprint(config.releaseKeyPrevious)}` : ""}`)
  return { config, store: createFreeAllowanceStore(config, "anonymous"), fetch: createInferenceEgressFetch(),
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
/** Guest Auto is turned off by configuration, not failing: the desktop hides Auto instead of calling it unavailable. */
function switchedOff() { return desktopFreeGateError(503, "free_disabled", "Auto is not offered here.") }
function versionResponse(error: DesktopFreeVersionError) {
  return Response.json({ error }, { status: error.code === "desktop_update_required" ? 426 : 503, headers: { "cache-control": "no-store" } })
}

/** Signed-out desktop Auto. Signed-in members use their OpenWork Models key on /api/v1 instead. */
export function registerAnonymousInferenceRoutes(app: Hono, dependencies = defaults()) {
  const { config, store } = dependencies
  const gateDependencies: DesktopFreeGateDependencies = { consumeNonce: store.consumeNonce, config, now: dependencies.now }
  const route = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { return await handler(c) } catch (error) { return errorResponse(error) }
  }
  app.post(DESKTOP_FREE_SESSION_PATH, route(async (c) => {
    if (!config.anonymousEnabled) return switchedOff()
    if (c.req.raw.headers.has("authorization") || new URL(c.req.url).search) return desktopFreeGateError(401, "invalid_anonymous_token")
    const address = dependencies.clientAddress(c)
    if (!address) return desktopFreeGateError(503, "anonymous_unavailable")
    const parsed = await readFreeRequest(c.req.raw, 4096, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]))
    const session = sessionSchema.safeParse(parsed.value)
    if (!session.success) return desktopFreeGateError(400, "invalid_request")
    const gate = await checkDesktopFreeRequest(c.req.raw, parsed.bodyHash, gateDependencies)
    if (gate.error) return gate.error
    if (gate.versionError) return versionResponse(gate.versionError)
    // Minting costs a little CPU, bound to this proof's single-use nonce so the work cannot be replayed.
    if (!verifySessionPow({ machineId: gate.proof.machineId, nonce: gate.proof.nonce, pow: session.data.pow, bits: config.sessionPowBits, rounds: config.sessionPowRounds })) {
      return Response.json({ error: { code: "session_pow_required", bits: config.sessionPowBits, rounds: config.sessionPowRounds, message: "A proof of work is required to start a guest session." } }, { status: 400, headers: { "cache-control": "no-store" } })
    }
    const identities = createAnonymousIdentities(gate.proof, address, config)
    await store.consumeSession(identities.installationHash)
    return c.json({ ...issueAnonymousToken(identities, gate.proof, config), model: DESKTOP_FREE_MODEL_ID }, 200, { "cache-control": "no-store" })
  }))

  /**
   * Like OpenCode Zen's anonymous free models: a request with no desktop proof and no key (or the literal key
   * "public") is served to any client, limited only by its IP's untagged budget and the shared caps.
   */
  function openRequest(request: Request) {
    if (request.headers.has(DESKTOP_FREE_PROOF_HEADER)) return false
    if (["x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.has(name))) return false
    return !request.headers.has("authorization") || bearer(request) === DESKTOP_FREE_OPEN_API_KEY
  }

  // A desktop request needs a guest token bound to this IP, plus a fresh signed proof from the same key and
  // machine over the exact method, path, body and token. An open request needs neither.
  async function authenticate(c: Context, bodyHash: string): Promise<{ error: Response } | { error?: undefined; principal: GuestPrincipal;
    versionError: DesktopFreeVersionError | null; minimumVersion: string | null; currentVersion: string }> {
    if (!config.anonymousEnabled) return { error: switchedOff() }
    const token = bearer(c.req.raw)
    const address = dependencies.clientAddress(c)
    if (openRequest(c.req.raw)) {
      // With the untagged budgets off, an open client is told Auto is unavailable to it, like an untagged build.
      if (!untaggedAutoEnabled(config)) return { principal: { kind: "installation", id: "", deviceless: true }, minimumVersion: null, currentVersion: "",
        versionError: { code: "desktop_build_unverified", currentVersion: "", minimumVersion: null, message: "The OpenWork free model is currently unavailable." } }
      if (!address) return { error: desktopFreeGateError(503, "anonymous_unavailable") }
      const ipHash = anonymousIpHash(address, config)
      return { principal: { kind: "installation", id: freeIdentityHash("open-ip", ipHash), untaggedIpHash: ipHash, deviceless: true },
        versionError: null, minimumVersion: null, currentVersion: "" }
    }
    const guest = token && address ? verifyAnonymousToken(token, address, config) : null
    if (!guest || !address) return { error: desktopFreeGateError(401, "invalid_anonymous_token") }
    const gate = await checkDesktopFreeRequest(c.req.raw, bodyHash, gateDependencies, guest)
    if (gate.error) return { error: gate.error }
    // The proof, not the token, decides: a token minted by a tagged build is still limited per IP on an untagged proof.
    const principal: GuestPrincipal = gate.proof.version === 2
      ? { kind: "installation", id: guest.installationHash, untaggedIpHash: guest.ipHash }
      : { kind: "installation", id: guest.installationHash }
    return { principal, versionError: gate.versionError, minimumVersion: gate.minimumVersion, currentVersion: gate.proof.appVersion }
  }

  app.get(DESKTOP_FREE_STATUS_PATH, route(async (c) => {
    if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
    const auth = await authenticate(c, sha256Hex(""))
    if (auth.error) return auth.error
    const status: DesktopFreeAccessStatus = { state: "unavailable", code: "anonymous_unavailable", currentVersion: auth.currentVersion,
      // Desktops up to v0.18.55 refuse a ready guest status without a minimum; with none configured, this build is it.
      minimumVersion: auth.minimumVersion ?? (auth.currentVersion || null), providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID,
      allowance: null, catalog: managedModelCatalog(), defaultPinned: false }
    if (auth.versionError) {
      status.state = auth.versionError.code === "desktop_update_required" ? "update_required" : "unavailable"
      status.code = auth.versionError.code
    } else Object.assign(status, await store.read(auth.principal))
    return c.json(status, 200, { "cache-control": "no-store" })
  }))
  app.get(DESKTOP_FREE_MODELS_PATH, route(async (c) => {
    if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
    const auth = await authenticate(c, sha256Hex(""))
    if (auth.error) return auth.error
    if (auth.versionError) return versionResponse(auth.versionError)
    return c.json({ object: "list", data: [{ id: DESKTOP_FREE_MODEL_ID, object: "model", created: 0, owned_by: "openwork" }] }, 200, { "cache-control": "no-store" })
  }))
  for (const path of [DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_RESPONSES_PATH]) app.post(path, route(async (c) => {
    if (!config.anonymousEnabled) return switchedOff()
    if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal])
    const parsed = await readFreeRequest(c.req.raw, config.maxBodyBytes, AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]))
    const auth = await authenticate(c, parsed.bodyHash)
    if (auth.error) return auth.error
    if (auth.versionError) return versionResponse(auth.versionError)
    const prepared = prepareFreeRequest(parsed.value, config, c.req.path === DESKTOP_FREE_RESPONSES_PATH ? "responses" : "chat")
    return dispatchFreeCompletion({ config, store, fetch: dependencies.fetch, principal: auth.principal,
      prepared, signal, controller })
  }))
  app.all("/api/anonymous", () => desktopFreeGateError(404, "not_found"))
  app.all("/api/anonymous/*", () => desktopFreeGateError(404, "not_found"))
}
