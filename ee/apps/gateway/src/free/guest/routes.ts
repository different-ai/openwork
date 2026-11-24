import { desktopChallenge, desktopProofRequired } from "../desktop-access.js"
import type { Context, Hono } from "hono"
import { freeAutoJourneyHash } from "@openwork-ee/den-db"
import { FreeAutoBusyError } from "../shared/capacity.js"
import { z } from "zod"
import {
  DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH,
  DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH, DESKTOP_FREE_RESPONSES_PATH, DESKTOP_FREE_SESSION_POW_PATTERN, DESKTOP_FREE_PROOF_HEADER, DESKTOP_FREE_OPEN_API_KEY,
  type DesktopFreeAccessStatus, type DesktopFreeVersionError,
} from "@openwork/free-auto"
import { managedModelCatalog } from "@openwork/types/den/inference"
import { createInferenceEgressFetch } from "@openwork-ee/gateway-upstreams"
import { anonymousIpHash, createAnonymousIdentities, issueAnonymousToken, resolveAnonymousClientAddress, verifyAnonymousToken } from "./identity.js"
import { createFreeAllowanceStore, type FreeAllowanceStore } from "../shared/allowance.js"
import { untaggedAutoEnabled, type AutoConfig } from "../shared/config.js"
import { freeIdentityHash, freeSafetyIdentifier, type GuestPrincipal } from "../shared/principal.js"
import { checkDesktopFreeRequest, desktopFreeGateError, type DesktopFreeGateDependencies } from "./gate.js"
import { releaseKeyFingerprint, sha256Hex, verifySessionPow } from "@openwork/free-auto/node"
import { dispatchFreeCompletion } from "../shared/dispatch.js"
import { FreeRequestError } from "../shared/errors.js"
import { prepareFreeRequest, readFreeRequest } from "../shared/request.js"
import { env } from "../../env.js"

const sessionSchema = z.strictObject({ credentialHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), pow: z.string().regex(DESKTOP_FREE_SESSION_POW_PATTERN).optional() })
export type FreeRouteDependencies = {
  config: AutoConfig;
  store: FreeAllowanceStore;
  fetch: typeof fetch;
  now?: () => number;
  requireDesktop?: typeof desktopProofRequired;
  clientAddress: (c: Context) => string | null;
}
function defaults(): FreeRouteDependencies {
  const config = env.freeAuto
  if (config.releaseKey) console.info(`[free-auto] release key fingerprint ${releaseKeyFingerprint(config.releaseKey)}${config.releaseKeyPrevious ? `, previous ${releaseKeyFingerprint(config.releaseKeyPrevious)}` : ""}`)
  return { config, requireDesktop: desktopProofRequired, store: createFreeAllowanceStore(config, "anonymous"), fetch: createInferenceEgressFetch(),
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
function switchedOff() { return desktopFreeGateError(503, "free_disabled", "Auto is not offered here.") }
function versionResponse(error: DesktopFreeVersionError) {
  return Response.json({ error }, { status: error.code === "desktop_update_required" ? 426 : 503, headers: { "cache-control": "no-store" } })
}

export function registerAnonymousInferenceRoutes(app: Hono, dependencies = defaults()) {
  const { config, store } = dependencies
  const gateDependencies: DesktopFreeGateDependencies = { consumeNonce: store.consumeNonce, config, now: dependencies.now }
  const route = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { return await handler(c) } catch (error) { return errorResponse(error) }
  }
  app.post(DESKTOP_FREE_SESSION_PATH, route(async (c) => {
    if (!config.anonymousEnabled && !config.memberEnabled) return switchedOff()
    if (c.req.raw.headers.has("authorization") || new URL(c.req.url).search) return desktopFreeGateError(401, "invalid_anonymous_token")
    const address = dependencies.clientAddress(c)
    if (!address) return desktopFreeGateError(503, "anonymous_unavailable")
    const parsed = await readFreeRequest(c.req.raw, 4096, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]))
    const session = sessionSchema.safeParse(parsed.value)
    if (!session.success) return desktopFreeGateError(400, "invalid_request")
    if (session.data.credentialHash ? !config.memberEnabled : !config.anonymousEnabled) return switchedOff()
    if (config.tokenSecret.length < 32 || config.releaseKey.length < 32) return switchedOff()
    const gate = await checkDesktopFreeRequest(c.req.raw, parsed.bodyHash, gateDependencies)
    if (gate.error) return gate.error
    if (gate.versionError) return versionResponse(gate.versionError)
    if (session.data.credentialHash && gate.proof.version !== 3) return desktopChallenge(config.minimumVersion)
    if (!verifySessionPow({ machineId: gate.proof.machineId, nonce: gate.proof.nonce, pow: session.data.pow, bits: config.sessionPowBits, rounds: config.sessionPowRounds })) {
      return Response.json({ error: { code: "session_pow_required", bits: config.sessionPowBits, rounds: config.sessionPowRounds, message: "A proof of work is required to start a guest session." } }, { status: 400, headers: { "cache-control": "no-store" } })
    }
    const identities = createAnonymousIdentities(gate.proof, address, config)
    await store.consumeSession(identities.installationHash)
    return c.json({ ...issueAnonymousToken(identities, gate.proof, config, Date.now(), session.data.credentialHash), model: DESKTOP_FREE_MODEL_ID }, 200, { "cache-control": "no-store" })
  }))

  function openRequest(request: Request) {
    if (request.headers.has(DESKTOP_FREE_PROOF_HEADER)) return false
    if (["x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.has(name))) return false
    return !request.headers.has("authorization") || bearer(request) === DESKTOP_FREE_OPEN_API_KEY
  }

  async function authenticate(c: Context, bodyHash: string): Promise<{ error: Response } | { error?: undefined; principal: GuestPrincipal;
    versionError: DesktopFreeVersionError | null; minimumVersion: string | null; currentVersion: string }> {
    if (!config.anonymousEnabled) return { error: switchedOff() }
    const token = bearer(c.req.raw)
    const address = dependencies.clientAddress(c)
    const strict = await dependencies.requireDesktop?.(null)
    if (openRequest(c.req.raw)) {
      if (strict) return { error: desktopChallenge(config.minimumVersion) }
      if (!untaggedAutoEnabled(config)) return { principal: { kind: "installation", id: "", deviceless: true }, minimumVersion: null, currentVersion: "",
        versionError: { code: "desktop_build_unverified", currentVersion: "", minimumVersion: null, message: "The OpenWork free model is currently unavailable." } }
      if (!address) return { error: desktopFreeGateError(503, "anonymous_unavailable") }
      const ipHash = anonymousIpHash(address, config)
      return { principal: { kind: "installation", id: freeIdentityHash("open-ip", ipHash), untaggedIpHash: ipHash, deviceless: true,
        journeyHash: freeAutoJourneyHash(c.req.header("x-openwork-free-journey")) ?? undefined, observationRateHash: ipHash },
        versionError: null, minimumVersion: null, currentVersion: "" }
    }
    const guest = token && address ? verifyAnonymousToken(token, address, config) : null
    if (!guest || guest.credentialHash || !address) return { error: desktopFreeGateError(401, "invalid_anonymous_token") }
    const gate = await checkDesktopFreeRequest(c.req.raw, bodyHash, gateDependencies, guest)
    if (gate.error) return { error: gate.error }
    if (strict && gate.proof.version !== 3) return { error: desktopChallenge(config.minimumVersion) }
    const principal: GuestPrincipal = gate.proof.version === 2
      ? { kind: "installation", id: guest.installationHash, untaggedIpHash: guest.ipHash }
      : { kind: "installation", id: guest.installationHash }
    principal.journeyHash = freeAutoJourneyHash(c.req.header("x-openwork-free-journey")) ?? undefined
    principal.observationRateHash = guest.ipHash
    return { principal, versionError: gate.versionError, minimumVersion: gate.minimumVersion, currentVersion: gate.proof.appVersion }
  }

  app.get(DESKTOP_FREE_STATUS_PATH, route(async (c) => {
    if (new URL(c.req.url).search) return desktopFreeGateError(400, "invalid_request")
    const auth = await authenticate(c, sha256Hex(""))
    if (auth.error) return auth.error
    const status: DesktopFreeAccessStatus = { state: "unavailable", code: "anonymous_unavailable", currentVersion: auth.currentVersion,
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
    const prepared = prepareFreeRequest(parsed.value, config, freeSafetyIdentifier(auth.principal), c.req.path === DESKTOP_FREE_RESPONSES_PATH ? "responses" : "chat")
    return dispatchFreeCompletion({ config, store, fetch: dependencies.fetch, principal: auth.principal,
      prepared, signal, controller })
  }))
  app.all("/api/anonymous", () => desktopFreeGateError(404, "not_found"))
  app.all("/api/anonymous/*", () => desktopFreeGateError(404, "not_found"))
}
