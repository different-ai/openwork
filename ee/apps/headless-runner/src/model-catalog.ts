import { z } from "zod"
import { headlessModelAccessSchema, type HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import type { Config } from "./config.js"
import { fetchGatewayModels, type ModelOption } from "./model.js"

/** A catalog is verified only by an authenticated gateway read, never by the configured default alone. */
export function gatewayModelCatalog(config: Config, readModels = fetchGatewayModels) {
  let cached: { at: number; models: ModelOption[] } | null = null
  return async (modelAccess?: HeadlessModelAccess) => {
    // Member catalogs are never cached under a deployment key or replaced by the deployment catalog.
    if (modelAccess) {
      try {
        const models = (await readModels(modelAccess)).filter((model) =>
          ![model.id, model.name].some((value) => value.includes(modelAccess.apiKey) || value.includes(modelAccess.baseUrl)))
        const defaultModel = models.some((model) => model.id === config.model.model) ? config.model.model : models[0]?.id ?? ""
        return { defaultModel, models, verified: models.length > 0 }
      } catch {
        return { defaultModel: "", models: [], verified: false }
      }
    }
    const fallback = { defaultModel: config.model.model, models: [{ id: config.model.model, name: config.model.model }], verified: false }
    if (!config.model.defaultApiKey) return fallback
    if (!cached || Date.now() - cached.at > 5 * 60_000) {
      try {
        cached = {
          at: Date.now(),
          models: await readModels({ baseUrl: config.model.baseUrl, protocol: config.model.protocol, apiKey: config.model.defaultApiKey }),
        }
      } catch {
        return fallback
      }
    }
    if (cached.models.length === 0) return fallback
    return { defaultModel: config.model.model, models: cached.models, verified: true }
  }
}

const catalogRequest = z.strictObject({ modelAccess: headlessModelAccessSchema })

/** Service-authenticated only; a credential-bearing catalog request is never cacheable. */
export async function scopedCatalogResponse(request: Request, catalog?: (access?: HeadlessModelAccess) => Promise<{ defaultModel: string; models: ModelOption[]; verified?: boolean }>): Promise<Response> {
  const headers = { "cache-control": "no-store" }
  const body = catalogRequest.safeParse(await request.json().catch(() => null))
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400, headers })
  if (!catalog) return Response.json({ error: "model_catalog_unavailable" }, { status: 503, headers })
  return Response.json(await catalog(body.data.modelAccess), { headers })
}
