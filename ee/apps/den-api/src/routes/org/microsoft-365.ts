import type { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { contextStorage, getContext } from "hono/context-storage"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getValidAccessToken } from "../../capability-sources/generic-oauth.js"
import { MicrosoftGraphClient, MicrosoftGraphMutationOutcomeUnknownError, MicrosoftGraphRequestError } from "../../capability-sources/microsoft-graph.js"
import { getOrgOAuthClient } from "../../capability-sources/oauth-credentials.js"
import { listNativeProviderUsableEntries, nativeProviderConnectionPolicyError, resolveDefaultNativeProviderCredentialId, type NativeProviderPolicyError } from "../../capability-sources/native-provider-connections.js"
import { clientSelectedFeatures, getNativeOAuthProvider, providerScopesSatisfy } from "../../capability-sources/provider-registry.js"
import { listTeamsForMember } from "../../orgs.js"
import { INTERNAL_CAPABILITY_CONNECTOR_HEADER, readInternalCapabilityConnectorId } from "../../session.js"
import type { OrgRouteVariables } from "./shared.js"

const CONNECT_MICROSOFT_ACCOUNT_MESSAGE = "Connect your Microsoft work account first: open Settings > Connect and use Connect your account on the Microsoft 365 row, or connect from the OpenWork Cloud dashboard."

const graphItemIdSchema = z.string().trim().min(1).max(512)
  .refine((value) => value !== "." && value !== ".." && !/[\s/\\?#]/.test(value), "Use a Microsoft Graph item id, not a path or URL.")

const emailAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
}).meta({ ref: "Microsoft365EmailAddress" })

const mailMessageSummarySchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  subject: z.string(),
  receivedDateTime: z.string(),
  preview: z.string(),
  from: emailAddressSchema.nullable(),
  to: z.array(emailAddressSchema),
  webLink: z.string(),
  hasAttachments: z.boolean(),
}).meta({ ref: "Microsoft365MailMessageSummary" })

const mailMessageSchema = mailMessageSummarySchema.extend({
  isDraft: z.boolean(),
  isRead: z.boolean(),
  categories: z.array(z.string()),
  parentFolderId: z.string(),
  cc: z.array(emailAddressSchema),
  body: z.string(),
  bodyContentType: z.string(),
  bodyTruncated: z.boolean(),
}).meta({ ref: "Microsoft365MailMessage" })

const mailMessagesQuerySchema = z.object({
  search: z.string().trim().min(1).max(1_000).optional().describe("Optional Outlook message search text."),
  maxResults: z.coerce.number().int().min(1).max(25).default(10).describe("Maximum messages to return, capped at 25."),
})

const mailMessageParamSchema = z.object({
  messageId: graphItemIdSchema.describe("Microsoft Graph message id."),
})

const mailMessagesResponseSchema = z.object({
  ok: z.literal(true),
  messages: z.array(mailMessageSummarySchema),
}).meta({ ref: "Microsoft365MailMessagesResponse" })

const mailMessageResponseSchema = z.object({
  ok: z.literal(true),
  message: mailMessageSchema,
}).meta({ ref: "Microsoft365MailMessageResponse" })

const mailDraftBodySchema = z.object({
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().trim().min(1).max(998),
  body: z.string().max(200_000),
}).meta({ ref: "Microsoft365MailDraftBody" })

const mailDraftResponseSchema = z.object({
  ok: z.literal(true),
  draft: mailMessageSchema,
}).meta({ ref: "Microsoft365MailDraftResponse" })

const mailSendBodySchema = z.object({
  confirmSend: z.literal(true).describe("Must be true only after the user explicitly requests sending this existing draft. Creating or reviewing a draft is not send authorization."),
}).strict().meta({ ref: "Microsoft365MailSendBody" })

const mailSendResponseSchema = z.object({
  ok: z.literal(true),
  draftId: z.string(),
  status: z.literal("accepted").describe("Graph accepted the send request. This is not confirmation of delivery."),
}).meta({ ref: "Microsoft365MailSendResponse" })

const mailReplyDraftBodySchema = z.object({
  comment: z.string().trim().min(1).max(20_000).describe("Reply text to save in a draft for user review; this does not send mail."),
}).strict().meta({ ref: "Microsoft365MailReplyDraftBody" })

const mailMessageUpdateBodySchema = z.object({
  isRead: z.boolean().optional(),
  categories: z.array(z.string().trim().min(1).max(255)).max(25).optional()
    .describe("Replace the message's categories with this list; an empty list clears them."),
}).strict().refine((value) => value.isRead !== undefined || value.categories !== undefined, "Provide isRead or categories.")
  .meta({ ref: "Microsoft365MailMessageUpdateBody" })

const mailMessageMoveBodySchema = z.object({
  destination: z.enum(["archive", "deleteditems", "inbox"]).describe("Named folder in the caller's mailbox. deleteditems moves to trash, never permanently deletes."),
  confirmTrash: z.literal(true).optional().describe("Required when destination is deleteditems. Set true only when the user explicitly requested moving this message to trash."),
}).strict().refine((value) => value.destination !== "deleteditems" || value.confirmTrash === true, {
  message: "Moving a message to deleteditems requires confirmTrash: true.", path: ["confirmTrash"],
}).meta({ ref: "Microsoft365MailMessageMoveBody" })

const calendarEventsQuerySchema = z.object({
  timeMin: z.string().datetime().describe("Inclusive lower bound for event start time."),
  timeMax: z.string().datetime().describe("Exclusive upper bound for event start time."),
  maxResults: z.coerce.number().int().min(1).max(100).default(25).describe("Maximum events to return, capped at 100."),
})

const calendarEventSchema = z.object({
  id: z.string(),
  subject: z.string(),
  preview: z.string(),
  start: z.string(),
  startTimeZone: z.string(),
  end: z.string(),
  endTimeZone: z.string(),
  isAllDay: z.boolean(),
  location: z.string(),
  organizer: emailAddressSchema.nullable(),
  attendees: z.array(emailAddressSchema),
  webLink: z.string(),
  onlineMeetingUrl: z.string().nullable(),
}).meta({ ref: "Microsoft365CalendarEvent" })

const calendarEventsResponseSchema = z.object({
  ok: z.literal(true),
  events: z.array(calendarEventSchema),
}).meta({ ref: "Microsoft365CalendarEventsResponse" })

const calendarEventBodySchema = z.object({
  subject: z.string().trim().min(1).max(255),
  body: z.string().max(20_000).optional(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  timeZone: z.string().trim().min(1).max(100).default("UTC"),
  location: z.string().trim().max(255).optional(),
  attendees: z.array(z.string().email()).max(100).optional(),
}).refine((value) => Date.parse(value.end) > Date.parse(value.start), {
  message: "end must be after start",
  path: ["end"],
}).meta({ ref: "Microsoft365CalendarEventBody" })

const calendarEventResponseSchema = z.object({
  ok: z.literal(true),
  event: calendarEventSchema,
}).meta({ ref: "Microsoft365CalendarEventResponse" })

const calendarEventParamSchema = z.object({ eventId: graphItemIdSchema })
const calendarEventUpdateBodySchema = z.object({
  confirmNotifications: z.literal(true).describe("The user explicitly authorized this update and potential attendee email notifications from Microsoft Graph."),
  subject: z.string().trim().min(1).max(255).optional(),
  body: z.string().max(20_000).optional(),
  start: z.string().max(40).datetime().optional().describe("New UTC start, with Z suffix. Rescheduling requires both start and end."),
  end: z.string().max(40).datetime().optional().describe("New UTC end, with Z suffix."),
  location: z.string().trim().max(255).optional(),
}).strict()
  .refine(({ confirmNotifications: _confirmation, ...fields }) => Object.values(fields).some((entry) => entry !== undefined), "Provide at least one event field.")
  .refine((value) => (value.start === undefined && value.end === undefined)
    || (value.start !== undefined && value.end !== undefined && Date.parse(value.end) > Date.parse(value.start)),
  "Rescheduling requires both start and end, with end after start.")
  .meta({ ref: "Microsoft365CalendarEventUpdateBody" })

const calendarCancelBodySchema = z.object({
  confirmCancel: z.literal(true).describe("The user explicitly requested cancellation, including attendee notifications."),
  comment: z.string().max(20_000).optional(),
}).strict().meta({ ref: "Microsoft365CalendarCancelBody" })

const calendarDeleteBodySchema = z.object({
  confirmDelete: z.literal(true).describe("The user explicitly requested deleting this event; organizer deletion can notify attendees."),
}).strict().meta({ ref: "Microsoft365CalendarDeleteBody" })

const calendarCancelResponseSchema = z.object({
  ok: z.literal(true), eventId: z.string(), status: z.literal("accepted"),
}).meta({ ref: "Microsoft365CalendarCancelResponse" })
const calendarDeleteResponseSchema = z.object({
  ok: z.literal(true), eventId: z.string(), status: z.literal("deleted"),
}).meta({ ref: "Microsoft365CalendarDeleteResponse" })

const driveFilesQuerySchema = z.object({
  query: z.string().trim().min(1).max(500).describe("Text to search in OneDrive file names and content."),
  maxResults: z.coerce.number().int().min(1).max(25).default(10).describe("Maximum files to return, capped at 25."),
})

const driveFileParamSchema = z.object({
  itemId: graphItemIdSchema.describe("Microsoft Graph drive item id."),
})

const driveItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nullable(),
  modifiedTime: z.string(),
  webUrl: z.string(),
  mimeType: z.string(),
  kind: z.enum(["file", "folder", "unknown"]),
}).meta({ ref: "Microsoft365DriveItem" })

const driveFilesResponseSchema = z.object({
  ok: z.literal(true),
  files: z.array(driveItemSchema),
}).meta({ ref: "Microsoft365DriveFilesResponse" })

const driveFileResponseSchema = z.object({
  ok: z.literal(true),
  file: driveItemSchema.extend({
    content: z.string().nullable(),
    contentBase64: z.string().nullable().describe("Standard base64-encoded file bytes for binary files; decode locally."),
    encoding: z.enum(["text", "base64", "none"]),
    contentType: z.string().nullable(),
    truncated: z.boolean(),
    contentUnavailableReason: z.enum(["folder", "file_too_large"]).nullable(),
  }),
}).meta({ ref: "Microsoft365DriveFileResponse" })

const driveFileWriteBodySchema = z.object({
  path: z.string().trim().min(1).max(512)
    .refine((value) => !value.split("/").some((segment) => segment === "." || segment === ".."), "path cannot contain . or .. segments"),
  content: z.string().max(200_000),
}).meta({ ref: "Microsoft365DriveFileWriteBody" })

const driveFileWriteResponseSchema = z.object({
  ok: z.literal(true),
  file: driveItemSchema,
}).meta({ ref: "Microsoft365DriveFileWriteResponse" })

const driveItemNameSchema = z.string().trim().min(1).max(255)
  .refine((value) => value !== "." && value !== ".." && !/["*:<>?\/\\|\u0000-\u001f]/.test(value) && !value.endsWith("."), "Use one valid OneDrive file or folder name, not a path.")
const driveItemUpdateBodySchema = z.object({
  name: driveItemNameSchema.optional(),
  parentId: graphItemIdSchema.optional().describe("Destination folder id within the calling member's same OneDrive; cross-drive moves are not supported."),
}).strict().refine((value) => value.name !== undefined || value.parentId !== undefined, "Provide name or parentId.")
  .meta({ ref: "Microsoft365DriveItemUpdateBody" })
const driveFolderBodySchema = z.object({
  parentId: graphItemIdSchema.describe("Existing parent folder id in the calling member's OneDrive."),
  name: driveItemNameSchema,
}).strict().meta({ ref: "Microsoft365DriveFolderBody" })

const teamsChatsQuerySchema = z.object({
  maxResults: z.coerce.number().int().min(1).max(50).default(20),
})

const teamsChatParamSchema = z.object({
  chatId: z.string().trim().min(1).max(1_024),
})

const teamsMessagesQuerySchema = z.object({
  maxResults: z.coerce.number().int().min(1).max(50).default(20),
})

const teamsMessageBodySchema = z.object({
  content: z.string().trim().min(1).max(20_000),
}).meta({ ref: "Microsoft365TeamsMessageBody" })

const teamsChatSchema = z.object({
  id: z.string(),
  topic: z.string(),
  chatType: z.string(),
  webUrl: z.string(),
  lastUpdatedDateTime: z.string(),
}).meta({ ref: "Microsoft365TeamsChat" })

const teamsMessageSchema = z.object({
  id: z.string(),
  createdDateTime: z.string(),
  content: z.string(),
  from: emailAddressSchema.nullable(),
  webUrl: z.string(),
}).meta({ ref: "Microsoft365TeamsMessage" })

const teamsChatsResponseSchema = z.object({
  ok: z.literal(true),
  chats: z.array(teamsChatSchema),
}).meta({ ref: "Microsoft365TeamsChatsResponse" })

const teamsMessagesResponseSchema = z.object({
  ok: z.literal(true),
  messages: z.array(teamsMessageSchema),
}).meta({ ref: "Microsoft365TeamsMessagesResponse" })

const teamsMessageResponseSchema = z.object({
  ok: z.literal(true),
  message: teamsMessageSchema,
}).meta({ ref: "Microsoft365TeamsMessageResponse" })

const needsConnectionSchema = z.object({
  error: z.literal("needs_connection"),
  message: z.string(),
}).meta({ ref: "Microsoft365NeedsConnectionError" })

const upstreamErrorSchema = z.object({
  error: z.literal("microsoft_graph_error"),
  message: z.string(),
  outcome: z.literal("unknown").optional(),
  retryable: z.literal(false).optional(),
}).meta({ ref: "Microsoft365GraphError" })

export type Microsoft365AccessToken =
  | { kind: "ok"; accessToken: string; scopes: string[] | null; enabledFeatures: string[] }
  | { kind: "needs_connection"; message: string }
  | { kind: "microsoft_graph_error"; message: string }
  | NativeProviderPolicyError

export type Microsoft365AccessTokenResolver = (input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}) => Promise<Microsoft365AccessToken>

export type Microsoft365RouteOptions = {
  graphBaseUrl?: string
  fetch?: typeof fetch
  resolveAccessToken?: Microsoft365AccessTokenResolver
  memberRoute?: MiddlewareHandler<{ Variables: OrgRouteVariables }>
}

async function defaultAccessTokenResolver(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}): Promise<Microsoft365AccessToken> {
  const provider = getNativeOAuthProvider("microsoft-365")
  if (!provider) {
    return { kind: "microsoft_graph_error", message: "microsoft-365 provider is not registered." }
  }
  const headers = getContext().req.raw.headers
  const requestedConnectorId = readInternalCapabilityConnectorId(headers)
  if (headers.has(INTERNAL_CAPABILITY_CONNECTOR_HEADER) && !requestedConnectorId) {
    return { kind: "needs_connection", message: CONNECT_MICROSOFT_ACCOUNT_MESSAGE }
  }
  const memberTeams = await listTeamsForMember({ organizationId: input.organizationId, memberId: input.orgMembershipId })
  const teamIds = memberTeams.map((team) => team.id)
  let credentialProviderId: string | null
  if (requestedConnectorId) {
    const entries = await listNativeProviderUsableEntries({ ...input, teamIds })
    const selected = entries.find((entry) => entry.id === requestedConnectorId)
    credentialProviderId = selected?.nativeProviderKey === provider.providerId ? selected.id : null
  } else {
    credentialProviderId = await resolveDefaultNativeProviderCredentialId({ ...input, nativeProviderKey: provider.providerId, teamIds })
  }
  if (!credentialProviderId) {
    return await nativeProviderConnectionPolicyError(input.organizationId)
      ?? { kind: "needs_connection", message: CONNECT_MICROSOFT_ACCOUNT_MESSAGE }
  }
  const client = await getOrgOAuthClient(input.organizationId, credentialProviderId)
  if (!client) {
    return { kind: "needs_connection", message: CONNECT_MICROSOFT_ACCOUNT_MESSAGE }
  }
  let token: Awaited<ReturnType<typeof getValidAccessToken>>
  try {
    token = await getValidAccessToken({ provider, credentialProviderId, ...input })
  } catch (error) {
    return { kind: "microsoft_graph_error", message: error instanceof Error ? error.message : "Microsoft OAuth token refresh failed." }
  }
  if ("error" in token) {
    return { kind: "needs_connection", message: CONNECT_MICROSOFT_ACCOUNT_MESSAGE }
  }
  return {
    kind: "ok",
    accessToken: token.accessToken,
    scopes: token.account.scopes,
    enabledFeatures: clientSelectedFeatures(provider, client.extra),
  }
}

function featureEnabled(token: Extract<Microsoft365AccessToken, { kind: "ok" }>, features: readonly string[]): boolean {
  return features.some((feature) => token.enabledFeatures.includes(feature))
}

function featureGranted(token: Extract<Microsoft365AccessToken, { kind: "ok" }>, features: readonly string[]): boolean {
  if (!token.scopes || token.scopes.length === 0) return false
  const provider = getNativeOAuthProvider("microsoft-365")
  if (!provider) return false
  return features.some((feature) => {
    if (!token.enabledFeatures.includes(feature)) return false
    const requiredScopes = provider.optionalFeatures?.[feature]
    if (!requiredScopes || requiredScopes.length === 0) return false
    return requiredScopes.every((scope) => providerScopesSatisfy(provider, token.scopes, scope))
  })
}

function missingPermissionMessage(label: string): string {
  return `Your connected Microsoft account is missing the ${label} permission. An admin can enable it on the Microsoft 365 connector in OpenWork Cloud -> Connectors; then reconnect your account.`
}

function disabledFeatureMessage(label: string): string {
  return `The workspace administrator has disabled ${label} for the Microsoft 365 connection.`
}

function graphError(error: unknown): { error: "microsoft_graph_error"; message: string; outcome?: "unknown"; retryable?: false } {
  if (error instanceof MicrosoftGraphMutationOutcomeUnknownError) {
    return { error: "microsoft_graph_error", message: error.message, outcome: "unknown", retryable: false }
  }
  if (error instanceof MicrosoftGraphRequestError) {
    return { error: "microsoft_graph_error", message: error.message }
  }
  return {
    error: "microsoft_graph_error",
    message: error instanceof Error ? error.message : "Microsoft Graph request failed.",
  }
}

function describeMutation(operationId: string, summary: string, description: string, responseSchema: z.ZodType) {
  return describeRoute({
    operationId,
    tags: ["Capability Sources"],
    summary,
    description: `${description} Uses only the calling member's delegated Microsoft 365 connection. Never automatically retry a mutation after a timeout, cancellation, or ambiguous response; inspect current state first.`,
    responses: {
      200: jsonResponse("Microsoft Graph mutation receipt returned.", responseSchema),
      401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      409: jsonResponse("The selected feature or delegated permission is missing.", needsConnectionSchema),
      413: jsonResponse("Request body exceeds 1 MiB.", z.object({ error: z.literal("invalid_request"), message: z.string() })),
      502: jsonResponse("Microsoft Graph rejected the request or the outcome is unknown.", upstreamErrorSchema),
    },
  })
}

/**
 * Delegated Microsoft 365 capabilities. Read and mutation routes both use the calling
 * member's delegated token from the shared native-provider vault. Tests and
 * self-host staging can inject a Graph base URL, fetch implementation, and
 * token resolver without changing production auth behavior.
 */
export function registerMicrosoft365Routes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  options: Microsoft365RouteOptions = {},
) {
  app.use("/v1/capabilities/microsoft-365/*", contextStorage())
  const resolveAccessToken = options.resolveAccessToken ?? defaultAccessTokenResolver
  const orgMemberRouteMiddleware = options.memberRoute ?? orgMemberRoute()
  const boundedMutationBody = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: "invalid_request", message: "Request exceeds 1 MiB." }, 413),
  })

  function graphClient(accessToken: string, signal?: AbortSignal) {
    return new MicrosoftGraphClient({
      accessToken,
      baseUrl: options.graphBaseUrl ?? env.microsoftGraphBaseUrl,
      fetch: options.fetch,
      signal,
    })
  }

  async function mutationClient(payload: OrgRouteVariables["organizationContext"], signal: AbortSignal, features: readonly string[], label: string) {
    if (!payload) return Response.json({ error: "unauthorized" }, { status: 401 })
    const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
    if (token.kind === "microsoft_graph_error") return Response.json({ error: token.kind, message: token.message }, { status: 502 })
    if (token.kind === "needs_connection" || token.kind === "policy_blocked") return Response.json({ error: token.kind, message: token.message }, { status: token.kind === "policy_blocked" ? 403 : 409 })
    if (!featureEnabled(token, features)) return Response.json({ error: "needs_connection", message: disabledFeatureMessage(label) }, { status: 409 })
    if (!featureGranted(token, features)) return Response.json({ error: "needs_connection", message: missingPermissionMessage(label) }, { status: 409 })
    return graphClient(token.accessToken, signal)
  }

  app.post(
    "/v1/capabilities/microsoft-365/mail-drafts/:messageId/send",
    describeMutation("sendMicrosoft365MailDraft", "Send an existing Outlook draft after explicit user confirmation", "Requires Mail.Send and the mailSend feature. Only send an existing draft the user explicitly requested to send. Graph HTTP 202 means accepted, not delivered.", mailSendResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(mailMessageParamSchema), jsonValidator(mailSendBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["mailSend"], "Outlook mail sending")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, ...await client.sendMailDraft(c.req.valid("param").messageId) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.post(
    "/v1/capabilities/microsoft-365/mail-message/:messageId/reply-draft",
    describeMutation("createMicrosoft365ReplyDraft", "Create a reply draft for a selected Outlook message", "Uses Graph createReply with Mail.ReadWrite and mailDraft. Preserves the selected message's reply context. Saves a draft for user review and never sends it.", mailDraftResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(mailMessageParamSchema), jsonValidator(mailReplyDraftBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["mailDraft"], "Outlook draft creation")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, draft: await client.createMailReplyDraft(c.req.valid("param").messageId, c.req.valid("json").comment) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.patch(
    "/v1/capabilities/microsoft-365/mail-message/:messageId",
    describeMutation("updateMicrosoft365MailMessage", "Update Outlook message read state or categories", "Requires Mail.ReadWrite and mailManage. Only changes isRead and/or replaces categories; cannot alter recipients or send messages.", mailMessageResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(mailMessageParamSchema), jsonValidator(mailMessageUpdateBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["mailManage"], "Outlook mail management")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, message: await client.updateMailMessage(c.req.valid("param").messageId, c.req.valid("json")) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.post(
    "/v1/capabilities/microsoft-365/mail-message/:messageId/move",
    describeMutation("moveMicrosoft365MailMessage", "Move an Outlook message to archive, deleted items, or inbox", "Requires Mail.ReadWrite and mailManage. Moves one message to a fixed named folder, never permanently deletes it. Moving to deleteditems also requires confirmTrash: true. Use the returned message id after moving, since Graph can change it.", mailMessageResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(mailMessageParamSchema), jsonValidator(mailMessageMoveBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["mailManage"], "Outlook mail management")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, message: await client.moveMailMessage(c.req.valid("param").messageId, c.req.valid("json").destination) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.patch(
    "/v1/capabilities/microsoft-365/calendar-events/:eventId",
    describeMutation("updateMicrosoft365CalendarEvent", "Edit or reschedule an Outlook calendar event", "Requires Calendars.ReadWrite and calendarWrite. Updates only supplied subject, body, location, or paired UTC start/end. Requires confirmNotifications: true because updates may email attendees.", calendarEventResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(calendarEventParamSchema), jsonValidator(calendarEventUpdateBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["calendarWrite"], "Outlook calendar read/write")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, event: await client.updateCalendarEvent(c.req.valid("param").eventId, c.req.valid("json")) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.post(
    "/v1/capabilities/microsoft-365/calendar-events/:eventId/cancel",
    describeMutation("cancelMicrosoft365CalendarEvent", "Cancel an Outlook meeting and notify attendees", "Requires Calendars.ReadWrite and calendarWrite. Only the meeting organizer can cancel via Graph. Requires explicit user cancellation confirmation; a 202 receipt means cancellation was accepted.", calendarCancelResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(calendarEventParamSchema), jsonValidator(calendarCancelBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["calendarWrite"], "Outlook calendar read/write")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, ...await client.cancelCalendarEvent(c.req.valid("param").eventId, c.req.valid("json").comment) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.delete(
    "/v1/capabilities/microsoft-365/calendar-events/:eventId",
    describeMutation("deleteMicrosoft365CalendarEvent", "Delete a selected Outlook calendar event", "Requires Calendars.ReadWrite and calendarWrite, plus explicit user deletion confirmation. Deleting an organizer's meeting can send cancellations to attendees. Graph 204 confirms deletion.", calendarDeleteResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(calendarEventParamSchema), jsonValidator(calendarDeleteBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["calendarWrite"], "Outlook calendar read/write")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, ...await client.deleteCalendarEvent(c.req.valid("param").eventId) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.patch(
    "/v1/capabilities/microsoft-365/drive-file/:itemId",
    describeMutation("updateMicrosoft365DriveItem", "Rename or move a OneDrive item within the same drive", "Requires Files.ReadWrite (or Files.ReadWrite.All) and filesWrite (or filesFull). Updates only the name and/or parent folder id in the caller's OneDrive; cannot move across drives or upload content.", driveFileWriteResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, paramValidator(driveFileParamSchema), jsonValidator(driveItemUpdateBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["filesWrite", "filesFull"], "OneDrive write")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, file: await client.updateDriveItem(c.req.valid("param").itemId, c.req.valid("json")) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.post(
    "/v1/capabilities/microsoft-365/drive-folders",
    describeMutation("createMicrosoft365DriveFolder", "Create a folder in the calling member's OneDrive", "Requires Files.ReadWrite (or Files.ReadWrite.All) and filesWrite (or filesFull). Creates one folder under an existing parent id. Name conflicts fail without overwriting or silently renaming anything.", driveFileWriteResponseSchema),
    orgMemberRouteMiddleware, boundedMutationBody, jsonValidator(driveFolderBodySchema),
    async (c) => {
      const client = await mutationClient(c.get("organizationContext"), c.req.raw.signal, ["filesWrite", "filesFull"], "OneDrive write")
      if (client instanceof Response) return client
      try {
        return c.json({ ok: true, file: await client.createDriveFolder(c.req.valid("json")) })
      } catch (error) { return c.json(graphError(error), 502) }
    },
  )

  app.get(
    "/v1/capabilities/microsoft-365/mail-messages",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List or search Outlook mail as the calling member",
      description: "Reads recent Outlook messages from the calling member's connected Microsoft 365 account. This capability is delegated and read-only.",
      responses: {
        200: jsonResponse("Outlook messages returned.", mailMessagesResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    queryValidator(mailMessagesQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["mailRead"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Outlook mail access") }, 409)
      }
      if (!featureGranted(token, ["mailRead"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Outlook mail read") }, 409)
      }

      try {
        const query = c.req.valid("query")
        const messages = await graphClient(token.accessToken).listMailMessages({
          search: query.search,
          maxResults: query.maxResults,
        })
        return c.json({ ok: true, messages })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/microsoft-365/mail-message/:messageId",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Read an Outlook message as the calling member",
      description: "Reads one Outlook message and requests its body as plain text, using the calling member's delegated Microsoft 365 connection.",
      responses: {
        200: jsonResponse("Outlook message returned.", mailMessageResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    paramValidator(mailMessageParamSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["mailRead"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Outlook mail access") }, 409)
      }
      if (!featureGranted(token, ["mailRead"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Outlook mail read") }, 409)
      }

      try {
        const { messageId } = c.req.valid("param")
        return c.json({ ok: true, message: await graphClient(token.accessToken).getMailMessage(messageId) })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/microsoft-365/calendar-events",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List Microsoft 365 calendar events as the calling member",
      description: "Lists the calling member's Outlook calendar events in a requested time range. This capability is delegated and read-only.",
      responses: {
        200: jsonResponse("Outlook calendar events returned.", calendarEventsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    queryValidator(calendarEventsQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["calendarRead"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Outlook calendar access") }, 409)
      }
      if (!featureGranted(token, ["calendarRead"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Outlook calendar read") }, 409)
      }

      try {
        const query = c.req.valid("query")
        const events = await graphClient(token.accessToken).listCalendarEvents({
          start: query.timeMin,
          end: query.timeMax,
          maxResults: query.maxResults,
        })
        return c.json({ ok: true, events })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/microsoft-365/drive-files",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Search OneDrive files as the calling member",
      description: "Searches the calling member's OneDrive by name and content, returning source links. This capability is delegated and read-only.",
      responses: {
        200: jsonResponse("OneDrive files returned.", driveFilesResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    queryValidator(driveFilesQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["filesRead", "filesWrite", "filesReadAll", "filesFull"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("OneDrive access") }, 409)
      }
      if (!featureGranted(token, ["filesRead", "filesWrite", "filesReadAll", "filesFull"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("OneDrive read") }, 409)
      }

      try {
        const query = c.req.valid("query")
        const files = await graphClient(token.accessToken).searchDriveItems({ query: query.query, maxResults: query.maxResults })
        return c.json({ ok: true, files })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/microsoft-365/drive-file/:itemId",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Read a OneDrive text or binary file as the calling member",
      description: "Returns OneDrive metadata and content using strict-UTF-8 content sniffing: text is returned regardless of MIME type, while binary files are returned as standard base64 up to 10 MiB. Folders and oversized files return metadata with an explicit contentUnavailableReason.",
      responses: {
        200: jsonResponse("OneDrive file returned.", driveFileResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    paramValidator(driveFileParamSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["filesRead", "filesWrite", "filesReadAll", "filesFull"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("OneDrive access") }, 409)
      }
      if (!featureGranted(token, ["filesRead", "filesWrite", "filesReadAll", "filesFull"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("OneDrive read") }, 409)
      }

      try {
        const { itemId } = c.req.valid("param")
        return c.json({ ok: true, file: await graphClient(token.accessToken).getDriveItemWithContent(itemId) })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.post(
    "/v1/capabilities/microsoft-365/mail-drafts",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Create an Outlook draft as the calling member",
      description: "Creates a draft in the calling member's mailbox. It never sends the message. Microsoft requires delegated Mail.ReadWrite for draft creation.",
      responses: {
        200: jsonResponse("Outlook draft created.", mailDraftResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    jsonValidator(mailDraftBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["mailDraft"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Outlook draft creation") }, 409)
      }
      if (!featureGranted(token, ["mailDraft"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Outlook mail read/write") }, 409)
      }

      try {
        const body = c.req.valid("json")
        const draft = await graphClient(token.accessToken).createMailDraft(body)
        return c.json({ ok: true, draft })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.post(
    "/v1/capabilities/microsoft-365/calendar-events",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Create an Outlook calendar event as the calling member",
      description: "Creates an event in the calling member's default calendar. Adding attendees can send Microsoft calendar invitations.",
      responses: {
        200: jsonResponse("Outlook calendar event created.", calendarEventResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    jsonValidator(calendarEventBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["calendarWrite"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Outlook calendar event creation") }, 409)
      }
      if (!featureGranted(token, ["calendarWrite"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Outlook calendar read/write") }, 409)
      }

      try {
        const event = await graphClient(token.accessToken).createCalendarEvent(c.req.valid("json"))
        return c.json({ ok: true, event })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.put(
    "/v1/capabilities/microsoft-365/drive-files",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Create or replace a OneDrive text file as the calling member",
      description: "Creates or replaces a bounded UTF-8 text file at a path in the calling member's OneDrive.",
      responses: {
        200: jsonResponse("OneDrive file written.", driveFileWriteResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    jsonValidator(driveFileWriteBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["filesWrite", "filesFull"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("OneDrive file writing") }, 409)
      }
      if (!featureGranted(token, ["filesWrite", "filesFull"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("OneDrive write") }, 409)
      }

      try {
        const file = await graphClient(token.accessToken).putDriveTextFile(c.req.valid("json"))
        return c.json({ ok: true, file })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/microsoft-365/teams-chats",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List Microsoft Teams chats as the calling member",
      description: "Lists the calling member's Microsoft Teams chats using delegated Chat.Read permission.",
      responses: {
        200: jsonResponse("Teams chats returned.", teamsChatsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    queryValidator(teamsChatsQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["teamsChatRead", "teamsChatSend"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Teams chat reading") }, 409)
      }
      if (!featureGranted(token, ["teamsChatRead", "teamsChatSend"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Teams chat read") }, 409)
      }

      try {
        const chats = await graphClient(token.accessToken).listTeamsChats(c.req.valid("query").maxResults)
        return c.json({ ok: true, chats })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.get(
    "/v1/capabilities/microsoft-365/teams-chats/:chatId/messages",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List messages in a Microsoft Teams chat as the calling member",
      description: "Reads recent messages from one Teams chat using delegated Chat.Read permission.",
      responses: {
        200: jsonResponse("Teams chat messages returned.", teamsMessagesResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    paramValidator(teamsChatParamSchema),
    queryValidator(teamsMessagesQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["teamsChatRead", "teamsChatSend"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Teams chat reading") }, 409)
      }
      if (!featureGranted(token, ["teamsChatRead", "teamsChatSend"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Teams chat read") }, 409)
      }

      try {
        const messages = await graphClient(token.accessToken).listTeamsMessages(
          c.req.valid("param").chatId,
          c.req.valid("query").maxResults,
        )
        return c.json({ ok: true, messages })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )

  app.post(
    "/v1/capabilities/microsoft-365/teams-chats/:chatId/messages",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Send a message to an existing Microsoft Teams chat as the calling member",
      description: "Sends one message to an existing Teams chat. The operation cannot create a new chat.",
      responses: {
        200: jsonResponse("Teams chat message sent.", teamsMessageResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Microsoft Graph rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRouteMiddleware,
    paramValidator(teamsChatParamSchema),
    jsonValidator(teamsMessageBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await resolveAccessToken({ organizationId: payload.organization.id, orgMembershipId: payload.currentMember.id })
      if (token.kind === "microsoft_graph_error") return c.json({ error: token.kind, message: token.message }, 502)
      if (token.kind === "needs_connection" || token.kind === "policy_blocked") return c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409)
      if (!featureEnabled(token, ["teamsChatSend"])) {
        return c.json({ error: "needs_connection", message: disabledFeatureMessage("Teams chat sending") }, 409)
      }
      if (!featureGranted(token, ["teamsChatSend"])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Teams chat send") }, 409)
      }

      try {
        const message = await graphClient(token.accessToken).sendTeamsMessage(
          c.req.valid("param").chatId,
          c.req.valid("json").content,
        )
        return c.json({ ok: true, message })
      } catch (error) {
        return c.json(graphError(error), 502)
      }
    },
  )
}
