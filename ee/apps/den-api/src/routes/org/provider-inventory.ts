import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { readProviderInventoryRevision } from "../../llm/provider-inventory.js"
import { providerInventoryEvents } from "../../llm/provider-inventory-watch.js"
import { orgMemberRoute, userSessionRoute } from "../../middleware/index.js"
import { jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

function inventoryPrincipal(c: { get: <K extends "organizationContext" | "session">(key: K) => OrgRouteVariables[K] }) {
  const actor = c.get("organizationContext")
  const session = c.get("session")
  if (!actor || !session) throw new Error("Provider inventory requires a user session.")
  return {
    organizationId: actor.organization.id, memberId: actor.currentMember.id, userId: actor.currentMember.userId,
    sessionId: normalizeDenTypeId("session", session.id), sessionToken: session.token,
  }
}

export function registerOrgProviderInventoryRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const streams = new Map<string, number>()
  const responses = {
    401: jsonResponse("Sign-in required.", unauthorizedSchema),
    404: jsonResponse("Organization not found or liveProviderSync disabled.", notFoundSchema),
    503: jsonResponse("Inventory unavailable; reconnect with backoff.", z.object({ error: z.string() })),
  }
  app.get("/v1/inference-providers/inventory/revision", describeRoute({
    tags: ["Inference Providers"], summary: "Read the caller's inference inventory revision",
    description: "Opaque revision covering the usable-provider list and connect payloads, including model configuration, access, team membership, credential readiness and the caller's gateway key. Read-only. Requires liveProviderSync and a signed-in user session.",
    ...{ "x-mcp": false },
    responses: { 200: jsonResponse("Current inventory revision.", z.object({ revision: z.string() })), ...responses },
  }), orgMemberRoute(), requireFeature("liveProviderSync"), userSessionRoute(), async (c) => {
    c.header("Cache-Control", "no-store")
    try { return c.json({ revision: await readProviderInventoryRevision(inventoryPrincipal(c)) }) }
    catch { return c.json({ error: "inventory_unavailable" }, 503) }
  })
  app.get("/v1/inference-providers/inventory/events", describeRoute({
    tags: ["Inference Providers"], summary: "Watch the caller's inference inventory",
    description: "SSE inventory.changed events with JSON {revision}, immediately on connect and whenever persisted inventory changes. Checks the shared database every two seconds and sends heartbeat comments. Session expiry, membership removal, rollout revocation or failed checks close the stream. Requires liveProviderSync and a signed-in user session; never sends credentials or inventory data.",
    ...{ "x-mcp": false },
    responses: {
      200: { description: "Inventory revision event stream.", content: { "text/event-stream": { schema: { type: "string" } } } },
      429: jsonResponse("At most four inventory streams per member per replica.", z.object({ error: z.string() })),
      ...responses,
    },
  }), orgMemberRoute(), requireFeature("liveProviderSync"), userSessionRoute(), async (c) => {
    const principal = inventoryPrincipal(c)
    const scope = `${principal.organizationId}:${principal.memberId}`
    const count = streams.get(scope) ?? 0
    if (count >= 4) return c.json({ error: "inventory_stream_limit" }, 429)
    streams.set(scope, count + 1)
    const release = () => {
      const remaining = (streams.get(scope) ?? 1) - 1
      if (remaining > 0) streams.set(scope, remaining)
      else streams.delete(scope)
    }
    try {
      return await providerInventoryEvents({ request: c.req.raw,
        expiresAt: c.get("session")?.expiresAt.getTime() ?? 0,
        read: () => readProviderInventoryRevision(principal), onClose: release })
    } catch { return c.json({ error: "inventory_unavailable" }, 503) }
  })
}
