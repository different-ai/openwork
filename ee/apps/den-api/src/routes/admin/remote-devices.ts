import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_KINDS,
  REMOTE_DEVICE_PROVIDERS,
  adminRemoteDeviceDetailResponseSchema,
  adminRemoteDeviceListResponseSchema,
} from "@openwork/types/den/remote-devices"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { listAdminRemoteDevices, readAdminRemoteDevice } from "../../remote-devices.js"
import type { AuthContextVariables } from "../../session.js"

const base = "/v1/admin/remote-devices"
const errors = {
  400: jsonResponse("Invalid filter or id.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("Platform administrator required.", forbiddenSchema),
}

const listQuerySchema = z.object({
  organizationId: z.string().optional(),
  search: z.string().max(160).optional(),
  kind: z.enum(REMOTE_DEVICE_KINDS).optional(),
  provider: z.enum(REMOTE_DEVICE_PROVIDERS).optional(),
  availability: z.enum(REMOTE_DEVICE_AVAILABILITIES).optional(),
  problems: z.enum(["true", "false"]).optional(),
  page: z.string().regex(/^\d{1,3}$/).optional(),
})

/**
 * /admin › Devices: every computer members can reach through OpenWork, across organizations, with what Den
 * knows that explains its state. Read-only, and not behind the `remoteDevices` feature: it is how we debug it.
 */
export function registerAdminRemoteDeviceRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(base, describeRoute({
    tags: ["Admin"],
    summary: "List devices across organizations",
    description: "Every computer in the devices registry: desktops running OpenWork Desktop, Workbot's cloud computers and registered virtual computers, most recently heard from first, 50 a page. Filter by organization, kind, provider, availability or `problems=true` (a warning or error in the last 24 hours), and search by name, provider id, organization, or owner name or email. Desktops that only registered a runner are copied in first. `summary` counts the whole deployment whatever the filters. Platform administrators only.",
    responses: { 200: jsonResponse("Devices returned.", adminRemoteDeviceListResponseSchema), ...errors },
  }), adminRoute(), queryValidator(listQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const query = c.req.valid("query")
    if (query.organizationId !== undefined && !isDenTypeId("organization", query.organizationId)) {
      return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    }
    return c.json(await listAdminRemoteDevices({
      organizationId: query.organizationId ? normalizeDenTypeId("organization", query.organizationId) : undefined,
      search: query.search,
      kind: query.kind,
      provider: query.provider,
      availability: query.availability,
      problems: query.problems === "true",
      page: query.page ? Number(query.page) : 1,
    }))
  })

  app.get(`${base}/:deviceId`, describeRoute({
    tags: ["Admin"],
    summary: "Get one device with everything that explains its state",
    description: "One device, including one removed from its owner's list: the latest desktop report (OS, computer use readiness per computer, macOS permissions), its 100 most recent events with their fixed codes, the desktop's runner registration (what remote sessions and Automations see), Den's content-free index row for a Workbot computer's conversation, and the features that are on for its owner. Never credentials, screen content or conversation text. Platform administrators only.",
    responses: { 200: jsonResponse("Device returned.", adminRemoteDeviceDetailResponseSchema), ...errors, 404: jsonResponse("Device not found.", notFoundSchema) },
  }), adminRoute(), async (c) => {
    c.header("Cache-Control", "no-store")
    const id = c.req.param("deviceId")
    if (!isDenTypeId("remoteDevice", id)) return c.json({ error: "invalid_request", message: "Invalid device id." }, 400)
    const detail = await readAdminRemoteDevice(normalizeDenTypeId("remoteDevice", id))
    return detail ? c.json(detail) : c.json({ error: "not_found", message: "Device not found." }, 404)
  })
}
