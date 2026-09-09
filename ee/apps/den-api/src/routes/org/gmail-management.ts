import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { GOOGLE_ACTION_MAX_BODY_BYTES, readGoogleActionJson, requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const MODIFY = "https://www.googleapis.com/auth/gmail.modify"
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose"
const READ = "https://www.googleapis.com/auth/gmail.readonly"
const LABELS = "https://www.googleapis.com/auth/gmail.labels"
const DRAFT_WRITE = [MODIFY, COMPOSE]
const DRAFT_READ = [MODIFY, COMPOSE, READ]
const LABEL_WRITE = [MODIFY, LABELS]
const LABEL_READ = [MODIFY, LABELS, READ, "https://www.googleapis.com/auth/gmail.metadata"]

const idSchema = z.string().min(1).max(512).refine((id) => id.trim() === id && id !== "." && id !== "..", "Expected a Gmail resource ID.")
const draftParams = z.object({ draftId: idSchema.describe("Existing Gmail draft ID, not its message ID.") }).strict()
const messageParams = z.object({ messageId: idSchema }).strict()
const labelParams = z.object({ labelId: idSchema }).strict()
const confirmation = z.object({
  confirm: z.literal(true).describe("True only when the user explicitly requested this action on this resource. Discovering or selecting a capability is not authorization."),
}).strict()
const messageSchema = z.looseObject({ id: z.string().trim().min(1), threadId: z.string().trim().min(1) })
const draftSchema = z.looseObject({ id: z.string().trim().min(1), message: messageSchema })
// Draft lists document id + threadId; minimal/metadata reads promise only message ID and labels.
const draftReadSchema = draftSchema.extend({ message: messageSchema.partial({ threadId: true }) })
const labelSchema = z.looseObject({ id: z.string().trim().min(1), name: z.string().min(1), type: z.enum(["user", "system"]) })
const draftListSchema = z.looseObject({
  drafts: z.array(draftSchema).max(100).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().nonnegative().optional(),
})
const labelListSchema = z.looseObject({ labels: z.array(labelSchema).optional() })
const labelBody = z.object({
  name: z.string().trim().min(1).max(225).describe("User label name."),
  messageListVisibility: z.enum(["show", "hide"]).optional(),
  labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
}).strict()
const modifyBody = z.object({
  addLabelIds: z.array(idSchema).max(100).default([]).describe("Add INBOX to unarchive, UNREAD to mark unread, STARRED to star, or user label IDs. Use the dedicated trash action for TRASH."),
  removeLabelIds: z.array(idSchema).max(100).default([]).describe("Remove INBOX to archive, UNREAD to mark read, STARRED to unstar, or user label IDs. Use the dedicated untrash action for TRASH."),
}).strict().superRefine((body, ctx) => {
  if (body.addLabelIds.length + body.removeLabelIds.length === 0) {
    ctx.addIssue({ code: "custom", message: "Specify at least one label change." })
  }
  for (const key of ["addLabelIds", "removeLabelIds"] as const) {
    if (new Set(body[key]).size !== body[key].length || body[key].some((id) => ["TRASH", "DRAFT", "DRAFTS", "SENT"].includes(id))) {
      ctx.addIssue({ code: "custom", path: [key], message: "Use unique, modifiable label IDs; TRASH requires the dedicated trash/untrash action." })
    }
  }
  if (body.addLabelIds.some((id) => body.removeLabelIds.includes(id))) {
    ctx.addIssue({ code: "custom", message: "Cannot add and remove the same label." })
  }
})

function route(operationId: string, summary: string, description: string, schema: z.ZodType) {
  return describeRoute({
    operationId, tags: ["Capability Sources"], summary,
    description: `${description} Uses only the calling member's selected connected Google account. Perform writes only when explicitly requested by the user; capability discovery or selection is not authorization. Never automatically retry an uncertain write.`,
    responses: {
      200: jsonResponse("Google's validated response.", schema),
      400: jsonResponse("Invalid input.", invalidRequestSchema),
      401: jsonResponse("Sign-in required.", unauthorizedSchema),
      409: jsonResponse("Missing permission or protected system label.", z.object({ error: z.string(), message: z.string() })),
      413: jsonResponse("Request exceeds 6 MiB.", z.object({ error: z.literal("invalid_request"), message: z.string() })),
      502: jsonResponse("Google rejected or did not confirm the operation.", z.object({ error: z.string(), message: z.string() })),
    },
  })
}

function gmailUrl(path: string) {
  return new URL(`${(env.googleApiBaseUrl ?? "https://gmail.googleapis.com").replace(/\/+$/, "")}/gmail/v1/users/me/${path}`)
}

async function readGoogleJson<S extends z.ZodType>(c: Context<{ Variables: OrgRouteVariables }>, response: Response, schema: S, write: boolean) {
  const parsed = schema.safeParse(await readGoogleActionJson(response))
  if (!parsed.success) {
    return { ok: false, reply: c.json({
      error: "google_api_error",
      message: write
        ? "Google did not return a valid confirmation. The operation may have completed; check Gmail before retrying."
        : "Google returned an invalid response.",
    }, 502) } as const
  }
  return { ok: true, data: parsed.data } as const
}

export function registerGmailManagementRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>, dependencies: GoogleWorkspaceActionDependencies) {
  const gmail = new Hono<{ Variables: OrgRouteVariables }>()
  const boundedBody = bodyLimit({ maxSize: GOOGLE_ACTION_MAX_BODY_BYTES, onError: (c) => c.json({ error: "invalid_request", message: "Request exceeds 6 MiB." }, 413) })
  async function execute(c: Context<{ Variables: OrgRouteVariables }>, scopes: readonly string[], url: URL, schema: z.ZodType, init: RequestInit = {}, requiredFeatures?: readonly string[]) {
    const result = await requestGoogleAction(c, dependencies, scopes, url, init, requiredFeatures)
    if (!result.ok) return result.reply
    const parsed = await readGoogleJson(c, result.response, schema, Boolean(init.method && init.method !== "GET"))
    if (!parsed.ok) return parsed.reply
    return c.json(parsed.data)
  }

  async function userLabel(c: Context<{ Variables: OrgRouteVariables }>, labelId: string) {
    const result = await requestGoogleAction(c, dependencies, LABEL_WRITE, gmailUrl(`labels/${encodeURIComponent(labelId)}`))
    if (!result.ok) return result
    const parsed = await readGoogleJson(c, result.response, labelSchema, false)
    if (!parsed.ok) return parsed
    if (parsed.data.id !== labelId || parsed.data.type !== "user") {
      return { ok: false, reply: c.json({ error: "protected_label", message: "Only the specified user-created label may be modified or deleted; system labels are protected." }, 409) } as const
    }
    return { ok: true } as const
  }

  async function remove(c: Context<{ Variables: OrgRouteVariables }>, scopes: readonly string[], url: URL) {
    const result = await requestGoogleAction(c, dependencies, scopes, url, { method: "DELETE" })
    if (!result.ok) return result.reply
    // Gmail delete methods return no resource: accept 204 or the documented empty JSON object.
    if (result.response.status !== 204) {
      const parsed = await readGoogleJson(c, result.response, z.object({}).strict(), true)
      if (!parsed.ok) return parsed.reply
    }
    return c.json({ ok: true })
  }

  gmail.post(
    "/v1/capabilities/google-workspace/gmail-draft/:draftId/send",
    route("sendGmailDraft", "Send an existing Gmail draft", "Sends the existing draft unchanged, including To/Cc/Bcc, reply threading and attachments. Create or inspect the draft first. Requires gmail.compose or gmail.modify (gmail.send alone does not authorize drafts.send). A successful response contains the actual sent message id and threadId, not the old draft message ID.", messageSchema),
    orgMemberRoute(), boundedBody, paramValidator(draftParams), jsonValidator(confirmation),
    async (c) => execute(c, DRAFT_WRITE, gmailUrl("drafts/send"), messageSchema, {
      method: "POST", body: JSON.stringify({ id: c.req.valid("param").draftId }),
    }, ["gmailSend", "gmailManage"]),
  )

  gmail.get(
    "/v1/capabilities/google-workspace/gmail-drafts",
    route("listGmailDrafts", "List or search Gmail drafts", "Returns one page of drafts and the actual nextPageToken, if any. Pass it as pageToken for the next page. Requires gmail.readonly, gmail.compose or gmail.modify.", draftListSchema),
    orgMemberRoute(), boundedBody,
    queryValidator(z.object({
      q: z.string().trim().min(1).max(1000).optional(),
      maxResults: z.coerce.number().int().min(1).max(100).default(25),
      pageToken: z.string().min(1).max(2048).optional(),
      includeSpamTrash: z.enum(["true", "false"]).optional(),
    }).strict()),
    async (c) => {
      const url = gmailUrl("drafts")
      for (const [key, value] of Object.entries(c.req.valid("query"))) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      return execute(c, DRAFT_READ, url, draftListSchema)
    },
  )

  gmail.get(
    "/v1/capabilities/google-workspace/gmail-draft/:draftId",
    route("getGmailDraft", "Read a Gmail draft", "Returns Google's draft and message content, capped at 6 MiB. Use format=raw for the base64url RFC 2822 message including MIME attachments. Requires gmail.readonly, gmail.compose or gmail.modify.", draftReadSchema),
    orgMemberRoute(), boundedBody, paramValidator(draftParams),
    queryValidator(z.object({ format: z.enum(["minimal", "full", "raw", "metadata"]).default("full") }).strict()),
    async (c) => {
      const url = gmailUrl(`drafts/${encodeURIComponent(c.req.valid("param").draftId)}`)
      url.searchParams.set("format", c.req.valid("query").format)
      return execute(c, DRAFT_READ, url, c.req.valid("query").format === "minimal" || c.req.valid("query").format === "metadata" ? draftReadSchema : draftSchema)
    },
  )

  gmail.put(
    "/v1/capabilities/google-workspace/gmail-draft/:draftId",
    route("updateGmailDraft", "Replace a Gmail draft's full content", "Replaces the draft message, not a partial text edit. Supply the complete base64url RFC 2822 MIME message, preserving intended recipients, reply headers, threadId and attachments. Read the existing draft first; omitted content is lost. Does not send. Requires gmail.compose or gmail.modify.", draftSchema),
    orgMemberRoute(), boundedBody, paramValidator(draftParams),
    jsonValidator(confirmation.extend({ message: z.object({
      raw: z.string().min(1).max(5_000_000).regex(/^[A-Za-z0-9_-]+={0,2}$/).describe("Complete base64url RFC 2822 MIME message, not just body text."),
      threadId: idSchema.optional().describe("Preserve the existing conversation's threadId for a reply, with matching subject and References/In-Reply-To headers in raw."),
    }).strict() }).strict()),
    async (c) => execute(c, DRAFT_WRITE, gmailUrl(`drafts/${encodeURIComponent(c.req.valid("param").draftId)}`), draftSchema, {
      method: "PUT", body: JSON.stringify({ message: c.req.valid("json").message }),
    }),
  )

  gmail.delete(
    "/v1/capabilities/google-workspace/gmail-draft/:draftId",
    route("deleteGmailDraft", "Permanently delete a Gmail draft", "Permanently discards the specified draft; this is not a move to trash. Requires gmail.compose or gmail.modify and explicit user confirmation.", z.object({ ok: z.literal(true) })),
    orgMemberRoute(), boundedBody, paramValidator(draftParams), jsonValidator(confirmation),
    async (c) => remove(c, DRAFT_WRITE, gmailUrl(`drafts/${encodeURIComponent(c.req.valid("param").draftId)}`)),
  )

  gmail.post(
    "/v1/capabilities/google-workspace/gmail-message/:messageId/modify",
    route("updateGmailMessageLabels", "Archive, unarchive, mark read or unread, star or change Gmail message labels", "Changes labels on one message. Archive removes INBOX; unarchive adds INBOX; mark read removes UNREAD; mark unread adds UNREAD; star adds STARRED; unstar removes STARRED. Supports user label IDs from gmail-labels. Requires gmail.modify, not gmail.labels or gmail.compose.", messageSchema),
    orgMemberRoute(), boundedBody, paramValidator(messageParams), jsonValidator(modifyBody),
    async (c) => execute(c, [MODIFY], gmailUrl(`messages/${encodeURIComponent(c.req.valid("param").messageId)}/modify`), messageSchema, {
      method: "POST", body: JSON.stringify(c.req.valid("json")),
    }),
  )

  gmail.post(
    "/v1/capabilities/google-workspace/gmail-message/:messageId/trash",
    route("trashGmailMessage", "Move a Gmail message to trash", "Moves one message to Gmail trash, not permanent deletion. Requires gmail.modify and explicit user confirmation.", messageSchema),
    orgMemberRoute(), boundedBody, paramValidator(messageParams), jsonValidator(confirmation),
    async (c) => execute(c, [MODIFY], gmailUrl(`messages/${encodeURIComponent(c.req.valid("param").messageId)}/trash`), messageSchema, { method: "POST" }),
  )

  gmail.post(
    "/v1/capabilities/google-workspace/gmail-message/:messageId/untrash",
    route("untrashGmailMessage", "Restore a Gmail message from trash", "Removes one message from trash. Requires gmail.modify. To put it in the inbox, also add INBOX using the modify capability.", messageSchema),
    orgMemberRoute(), boundedBody, paramValidator(messageParams),
    async (c) => execute(c, [MODIFY], gmailUrl(`messages/${encodeURIComponent(c.req.valid("param").messageId)}/untrash`), messageSchema, { method: "POST" }),
  )

  gmail.get(
    "/v1/capabilities/google-workspace/gmail-labels",
    route("listGmailLabels", "List Gmail labels", "Returns user and system labels with IDs and types; only user labels can be edited or deleted. Requires gmail.labels, gmail.readonly, gmail.metadata or gmail.modify.", labelListSchema),
    orgMemberRoute(), boundedBody,
    async (c) => execute(c, LABEL_READ, gmailUrl("labels"), labelListSchema),
  )

  gmail.post(
    "/v1/capabilities/google-workspace/gmail-labels",
    route("createGmailLabel", "Create a Gmail user label", "Creates a custom user label with its name and optional visibility settings. Requires gmail.labels or gmail.modify.", labelSchema),
    orgMemberRoute(), boundedBody, jsonValidator(labelBody),
    async (c) => execute(c, LABEL_WRITE, gmailUrl("labels"), labelSchema, { method: "POST", body: JSON.stringify(c.req.valid("json")) }),
  )

  gmail.patch(
    "/v1/capabilities/google-workspace/gmail-label/:labelId",
    route("updateGmailLabel", "Update a Gmail user label", "Renames or changes visibility of a user label. Reads its type first and refuses system labels. Requires gmail.labels or gmail.modify.", labelSchema),
    orgMemberRoute(), boundedBody, paramValidator(labelParams),
    jsonValidator(labelBody.partial().refine((body) => Object.keys(body).length > 0, "Specify at least one label field.")),
    async (c) => {
      const { labelId } = c.req.valid("param")
      const allowed = await userLabel(c, labelId)
      if (!allowed.ok) return allowed.reply
      return execute(c, LABEL_WRITE, gmailUrl(`labels/${encodeURIComponent(labelId)}`), labelSchema, { method: "PATCH", body: JSON.stringify(c.req.valid("json")) })
    },
  )

  gmail.delete(
    "/v1/capabilities/google-workspace/gmail-label/:labelId",
    route("deleteGmailLabel", "Permanently delete a Gmail user label", "Permanently removes the user label and its assignment from every message and thread, without deleting the messages. Reads its type first and refuses system labels. Requires gmail.labels or gmail.modify and explicit user confirmation.", z.object({ ok: z.literal(true) })),
    orgMemberRoute(), boundedBody, paramValidator(labelParams), jsonValidator(confirmation),
    async (c) => {
      const { labelId } = c.req.valid("param")
      const allowed = await userLabel(c, labelId)
      if (!allowed.ok) return allowed.reply
      return remove(c, LABEL_WRITE, gmailUrl(`labels/${encodeURIComponent(labelId)}`))
    },
  )
  app.route("/", gmail)
}
