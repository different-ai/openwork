import {
  COMPUTER_DISCONNECTED_ERROR,
  REMOTE_DEVICE_REPORT_INTERVAL_SECONDS,
  remoteDeviceDesktopReportResponseSchema,
  remoteDeviceDesktopReportSchema,
  remoteDeviceDetailResponseSchema,
  remoteDeviceDisconnectResponseSchema,
  remoteDeviceListResponseSchema,
  remoteDeviceRegisterRequestSchema,
  remoteDeviceResponseSchema,
  remoteDeviceUpdateRequestSchema,
} from "@openwork/types/den/remote-devices"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { ComputerDisconnectedError, computerDisconnectedBody, signInSessionOf } from "../../computer-disconnect.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import {
  disconnectMemberRemoteDevice,
  listMemberRemoteDevices,
  readMemberRemoteDevice,
  registerRemoteDevice,
  RemoteDeviceError,
  removeRemoteDevice,
  renameRemoteDevice,
  reportDesktopDevice,
  type RemoteDeviceActor,
} from "../../remote-devices.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import { hasPermission, type OrgRouteVariables, type PermissionRouteContext } from "./shared.js"

const deviceParamsSchema = z.object({ deviceId: denTypeIdSchema("remoteDevice") })
const errorSchema = z.object({ error: z.string(), message: z.string() })
const rateLimitedSchema = z.object({ error: z.literal("rate_limited") })
const computerDisconnectedSchema = z.object({ error: z.literal(COMPUTER_DISCONNECTED_ERROR), message: z.string() })

const unauthorized = jsonResponse("Authentication required.", unauthorizedSchema)
const featureOff = jsonResponse("The organization was not found, or Devices is off for it.", notFoundSchema)
const deviceNotFound = jsonResponse("No such computer for this member, or Devices is off for the organization.", notFoundSchema)
const sharedForbidden = jsonResponse("Changing a computer shared with the whole organization needs the Manage desktop policies permission.", forbiddenSchema)

/** A desktop reports on launch, on change and every five minutes; this leaves room for several desktops and retries. */
const DESKTOP_REPORT_RATE_LIMIT = 60
const DESKTOP_REPORT_RATE_WINDOW_MS = 10 * 60_000

function actorOf(c: PermissionRouteContext): RemoteDeviceActor | null {
  const context = c.get("organizationContext")
  return context ? { organizationId: context.organization.id, memberId: context.currentMember.id } : null
}

/** Computers shared with the whole organization are an admin's to register, rename and remove. */
const canManageShared = (c: PermissionRouteContext) => hasPermission(c, "desktop_policies.manage")

/** The response for a refusal from remote-devices.ts; anything else is rethrown. */
export function remoteDeviceFailure(error: unknown) {
  if (!(error instanceof RemoteDeviceError)) throw error
  const status = error.code === "remote_device_not_found" ? 404 as const : error.code === "remote_device_forbidden" ? 403 as const : 409 as const
  return { body: { error: error.code, message: error.message }, status }
}

const describeReportRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const describeDeviceReadRoute = (options: DescribeRouteOptions & { "x-mcp": true }) => describeRoute(options)

/**
 * Devices (feature `remoteDevices`): the computers the calling member can reach through OpenWork. Desktop's
 * Settings › Devices reads and reports here; Workbot uses the same registry through /v1/workbot/devices.
 */
export function registerOrgRemoteDeviceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/remote-devices",
    describeDeviceReadRoute({
      tags: ["Devices"],
      summary: "List the computers I can reach",
      "x-mcp": true,
      description: "The caller's own computers (Macs and PCs running OpenWork Desktop, Workbot's cloud computers, virtual computers they registered) and the ones registered for the whole organization, online first. `availability` is worked out from the last report: a desktop is online for ten minutes after it was last heard from; Workbot's computer is paused only after an observed pause; a stale ready report is unknown. Desktops not heard from for 30 days are left out. `remoteAccess` on a signed-in desktop that takes tasks from other devices says what they may do there (off, created or all), whether its owner chose it on that computer, and why when something else decides it: the organization's limit, an app that has to be updated before it can be allowed, or an owner who has not allowed it yet where the organization asks them to; null for every other computer. Names, versions and state only: never credentials or anything from the computer's screen. Needs the Devices feature.",
      responses: { 200: jsonResponse("The computers.", remoteDeviceListResponseSchema), 401: unauthorized, 404: featureOff },
    }),
    orgMemberRoute(),
    requireFeature("remoteDevices"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      return c.json({ devices: await listMemberRemoteDevices(actor, { canManageShared: await canManageShared(c) }) })
    },
  )

  app.post(
    "/v1/remote-devices",
    describeRoute({
      tags: ["Devices"],
      summary: "Register a virtual computer",
      description: "Adds a Freestyle or Daytona VM, a Mac sandbox or another virtual computer to the caller's list by the id its provider shows, or with `shared` to everyone's list in the organization (needs the Manage desktop policies permission). Registering names the computer in OpenWork; it stores no credentials and grants no access at the provider. Desktops and Workbot's computers register themselves. Needs the Devices feature.",
      responses: {
        201: jsonResponse("The computer was registered.", remoteDeviceResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: unauthorized,
        403: sharedForbidden,
        404: featureOff,
        409: jsonResponse("This computer is already registered in the organization.", errorSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteDevices"),
    jsonValidator(remoteDeviceRegisterRequestSchema),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      try {
        return c.json({ device: await registerRemoteDevice(actor, c.req.valid("json"), { canManageShared: await canManageShared(c) }) }, 201)
      } catch (error) {
        const failed = remoteDeviceFailure(error)
        return c.json(failed.body, failed.status)
      }
    },
  )

  app.put(
    "/v1/remote-devices/this-computer",
    describeReportRoute({
      tags: ["Devices"],
      "x-mcp": false,
      summary: "Report this desktop and how its computer use is doing",
      description: "Sent by the signed-in desktop app on launch, when something changes and every few minutes. Creates or refreshes this desktop in the caller's list, records what changed (app update, computer use needing setup, the computer agents use) and does the same for VMs the desktop is configured to reach. Names, versions and readiness only: no file paths, window titles or screen content. `installId` is the id the desktop registers its runner with, so the same computer is one entry. A desktop that was disconnected from the organization is answered 403 computer_disconnected and its entry is left as it was, unless the report comes with a sign-in made after the disconnect, which connects it again. Needs the Devices feature.",
      responses: {
        200: jsonResponse("This desktop as listed, and when to report again.", remoteDeviceDesktopReportResponseSchema),
        400: jsonResponse("The report was invalid.", invalidRequestSchema),
        401: unauthorized,
        403: jsonResponse("This computer was disconnected from the organization. Signing in on it again connects it.", computerDisconnectedSchema),
        404: featureOff,
        429: jsonResponse("Too many reports from this member; Retry-After says when to send again.", rateLimitedSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteDevices"),
    jsonValidator(remoteDeviceDesktopReportSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      const retryAfter = await checkRateLimit(`remote-devices:desktop-report:${actor.memberId}`, DESKTOP_REPORT_RATE_LIMIT, DESKTOP_REPORT_RATE_WINDOW_MS, Date.now())
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited" as const }, 429)
      }
      try {
        const device = await reportDesktopDevice(actor, c.req.valid("json"), { canManageShared: await canManageShared(c), session: signInSessionOf(c) })
        return c.json({ device, reportAfterSeconds: REMOTE_DEVICE_REPORT_INTERVAL_SECONDS })
      } catch (error) {
        if (error instanceof ComputerDisconnectedError) return c.json(computerDisconnectedBody, 403)
        throw error
      }
    },
  )

  app.get(
    "/v1/remote-devices/:deviceId",
    describeDeviceReadRoute({
      tags: ["Devices"],
      summary: "Get one of my computers and its recent activity",
      "x-mcp": true,
      description: "One computer from the caller's list with its 20 most recent events, newest first: when it registered, state changes, app updates, and for Workbot's computer when a view was opened, paused, resumed or rebuilt. Needs the Devices feature.",
      responses: { 200: jsonResponse("The computer and its recent activity.", remoteDeviceDetailResponseSchema), 400: jsonResponse("Invalid computer id.", invalidRequestSchema), 401: unauthorized, 404: deviceNotFound },
    }),
    orgMemberRoute(),
    requireFeature("remoteDevices"),
    paramValidator(deviceParamsSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      const detail = await readMemberRemoteDevice(actor, c.req.valid("param").deviceId, { canManageShared: await canManageShared(c) })
      if (!detail) return c.json({ error: "remote_device_not_found" }, 404)
      return c.json(detail)
    },
  )

  app.patch(
    "/v1/remote-devices/:deviceId",
    describeRoute({
      tags: ["Devices"],
      summary: "Rename a computer I registered",
      description: "Renames a virtual computer that was registered by hand. Desktops name themselves and Workbot's computers are named after their chat, so both answer 403. Needs the Devices feature.",
      responses: {
        200: jsonResponse("The renamed computer.", remoteDeviceResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: unauthorized,
        403: jsonResponse("This computer names itself, or it is shared and the caller cannot manage shared computers.", forbiddenSchema),
        404: deviceNotFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteDevices"),
    paramValidator(deviceParamsSchema),
    jsonValidator(remoteDeviceUpdateRequestSchema),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      try {
        return c.json({ device: await renameRemoteDevice(actor, c.req.valid("param").deviceId, c.req.valid("json").label, { canManageShared: await canManageShared(c) }) })
      } catch (error) {
        const failed = remoteDeviceFailure(error)
        return c.json(failed.body, failed.status)
      }
    },
  )

  app.delete(
    "/v1/remote-devices/:deviceId",
    describeRoute({
      tags: ["Devices"],
      summary: "Remove a computer from my list",
      description: "Takes the computer off the list. Nothing is stopped or deleted at its provider, and a desktop or Workbot computer that reports again comes back: `canRemove` is false for a signed-in desktop until it is disconnected or has been quiet for 30 days. Needs the Devices feature.",
      responses: { 204: { description: "Removed." }, 400: jsonResponse("Invalid computer id.", invalidRequestSchema), 401: unauthorized, 403: sharedForbidden, 404: deviceNotFound },
    }),
    orgMemberRoute(),
    requireFeature("remoteDevices"),
    paramValidator(deviceParamsSchema),
    async (c) => {
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      try {
        await removeRemoteDevice(actor, c.req.valid("param").deviceId, { canManageShared: await canManageShared(c) })
        return c.body(null, 204)
      } catch (error) {
        const failed = remoteDeviceFailure(error)
        return c.json(failed.body, failed.status)
      }
    },
  )

  app.post(
    "/v1/remote-devices/:deviceId/disconnect",
    describeRoute({
      tags: ["Devices"],
      summary: "Disconnect one of my computers",
      description: "Disconnects the caller's own signed-in desktop from the organization. Den stops accepting that install as their computer at once: it gets no runner credential, takes no remote tasks, shares no sessions and its reports are refused with 403 computer_disconnected; work that was going through it is failed. Where Den knows the sign-in the desktop uses and it is not the one making this request, that sign-in is ended too (`signedOut`), so OpenWork there is signed out. The computer stays in the list as disconnected; signing in on it again connects it again. Repeating the call changes nothing. Someone else's computer answers 404; a computer that never signs in (a virtual computer, Workbot's) answers 409 not_disconnectable. Needs a signed-in session and the Devices feature.",
      responses: {
        200: jsonResponse("The computer, now disconnected, and whether its sign-in was ended.", remoteDeviceDisconnectResponseSchema),
        400: jsonResponse("Invalid computer id.", invalidRequestSchema),
        401: unauthorized,
        403: jsonResponse("API keys and agents cannot disconnect a computer.", forbiddenSchema),
        404: deviceNotFound,
        409: jsonResponse("This computer never signs in, so there is nothing to disconnect.", errorSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteDevices"),
    paramValidator(deviceParamsSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const actor = actorOf(c)
      if (!actor) return c.json({ error: "organization_not_found" }, 404)
      const session = signInSessionOf(c)
      if (!session) return c.json({ error: "forbidden", message: "Sign in to disconnect a computer." }, 403)
      try {
        return c.json(await disconnectMemberRemoteDevice(actor, c.req.valid("param").deviceId, { sessionId: session.id, canManageShared: await canManageShared(c) }))
      } catch (error) {
        const failed = remoteDeviceFailure(error)
        return c.json(failed.body, failed.status)
      }
    },
  )
}
