import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { GOOGLE_ACTION_MAX_BODY_BYTES, readGoogleActionJson, requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const scope = "https://www.googleapis.com/auth/"
const SPACES_READ = [scope + "chat.spaces.readonly", scope + "chat.spaces"]
const MESSAGES_READ = [scope + "chat.messages.readonly", scope + "chat.messages"]
const MESSAGES_CREATE = [scope + "chat.messages.create", scope + "chat.messages"]
const CHAT_FEATURES = ["chat"]
const base = "/v1/capabilities/google-workspace"

const resourceIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
const spaceParams = z.object({
  spaceId: resourceIdSchema.describe("The ID after spaces/ in a space name, e.g. AAAA1234 for spaces/AAAA1234."),
}).strict()
const pageSchema = {
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  pageToken: z.string().min(1).max(2048).optional().describe("nextPageToken from the previous page of the same request."),
}
// Zod objects strip unlisted keys, so responses keep only what an agent needs.
const spaceSchema = z.object({
  name: z.string().regex(/^spaces\/[A-Za-z0-9_-]+$/),
  spaceType: z.string().optional(),
  displayName: z.string().optional(),
  spaceUri: z.string().optional(),
  lastActiveTime: z.string().optional(),
}).meta({ ref: "GoogleChatSpace" })
const messageSchema = z.object({
  name: z.string().min(1),
  createTime: z.string().optional(),
  text: z.string().optional(),
  sender: z.object({ name: z.string().optional(), displayName: z.string().optional(), type: z.string().optional() }).optional(),
  thread: z.object({ name: z.string() }).optional(),
}).meta({ ref: "GoogleChatMessage" })
const spaceListSchema = z.object({ spaces: z.array(spaceSchema).optional(), nextPageToken: z.string().optional() }).meta({ ref: "GoogleChatSpaceList" })
const messageListSchema = z.object({ messages: z.array(messageSchema).optional(), nextPageToken: z.string().optional() }).meta({ ref: "GoogleChatMessageList" })
const sendBody = z.object({
  text: z.string().trim().min(1).max(4_096).describe("Plain message text, up to 4,096 characters."),
  threadName: z.string().regex(/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/).optional()
    .describe("Reply in this existing thread of the same space (a message's thread.name). Omit to start a new thread."),
  confirm: z.literal(true).describe("True only after the user explicitly asked to send this message to this space. Finding the space or drafting the text is not send authorization."),
}).strict()

function route(operationId: string, summary: string, description: string, schema: z.ZodType) {
  return describeRoute({
    operationId, tags: ["Capability Sources"], summary,
    description: `${description} Uses only the calling member's selected connected Google account and requires the Google Chat permission on the Google Workspace connector.`,
    responses: {
      200: jsonResponse("Google's validated response.", schema),
      400: jsonResponse("Invalid input.", invalidRequestSchema),
      401: jsonResponse("Sign-in required.", unauthorizedSchema),
      409: jsonResponse("Missing permission or Google Chat is not enabled for the connector.", z.object({ error: z.string(), message: z.string() })),
      502: jsonResponse("Google rejected or did not confirm the operation.", z.object({ error: z.string(), message: z.string() })),
    },
  })
}

function chatUrl(path: string) {
  return new URL(`${(env.googleApiBaseUrl ?? "https://chat.googleapis.com").replace(/\/+$/, "")}/v1/${path}`)
}

export function registerGoogleChatRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>, dependencies: GoogleWorkspaceActionDependencies) {
  const chat = new Hono<{ Variables: OrgRouteVariables }>()
  const boundedBody = bodyLimit({ maxSize: GOOGLE_ACTION_MAX_BODY_BYTES, onError: (c) => c.json({ error: "invalid_request", message: "Request exceeds 6 MiB." }, 413) })
  async function execute(c: Context<{ Variables: OrgRouteVariables }>, scopes: readonly string[], url: URL, schema: z.ZodType, init: RequestInit = {}) {
    const result = await requestGoogleAction(c, dependencies, scopes, url, init, CHAT_FEATURES)
    if (!result.ok) return result.reply
    const parsed = schema.safeParse(await readGoogleActionJson(result.response))
    if (!parsed.success) {
      return c.json({
        error: "google_api_error",
        message: init.method === "POST"
          ? "Google did not return a valid confirmation. The message may have been sent; check Google Chat before retrying."
          : "Google returned an invalid response.",
      }, 502)
    }
    return c.json(parsed.data)
  }
  function withPage(url: URL, query: { pageSize: number; pageToken?: string }) {
    url.searchParams.set("pageSize", String(query.pageSize))
    if (query.pageToken) url.searchParams.set("pageToken", query.pageToken)
    return url
  }

  chat.get(
    `${base}/chat-spaces`,
    route("listGoogleChatSpaces", "List Google Chat spaces, group chats and direct messages", "Lists conversations the member belongs to, one page at a time. Filter by spaceType to list only direct messages, group chats or named spaces. To find the direct message with one person, use findGoogleChatDirectMessage.", spaceListSchema),
    orgMemberRoute(), boundedBody,
    queryValidator(z.object({
      spaceType: z.enum(["SPACE", "GROUP_CHAT", "DIRECT_MESSAGE"]).optional(),
      ...pageSchema,
    }).strict()),
    async (c) => {
      const query = c.req.valid("query")
      const url = withPage(chatUrl("spaces"), query)
      if (query.spaceType) url.searchParams.set("filter", `spaceType = "${query.spaceType}"`)
      return execute(c, SPACES_READ, url, spaceListSchema)
    },
  )

  chat.get(
    `${base}/chat-direct-message`,
    route("findGoogleChatDirectMessage", "Find the Google Chat direct message with a person", "Returns the existing one-to-one direct message between the member and the person with this email. Google returns 404 when they have no direct message yet; this action cannot start one.", spaceSchema),
    orgMemberRoute(), boundedBody,
    queryValidator(z.object({ email: z.string().trim().email().max(320).describe("The other person's Google account email.") }).strict()),
    async (c) => {
      const url = chatUrl("spaces:findDirectMessage")
      url.searchParams.set("name", `users/${c.req.valid("query").email}`)
      return execute(c, SPACES_READ, url, spaceSchema)
    },
  )

  chat.get(
    `${base}/chat-spaces/:spaceId/messages`,
    route("listGoogleChatMessages", "Read recent messages in a Google Chat space", "Returns messages newest first, one page at a time, with text, sender and thread.", messageListSchema),
    orgMemberRoute(), boundedBody, paramValidator(spaceParams),
    queryValidator(z.object(pageSchema).strict()),
    async (c) => {
      const url = withPage(chatUrl(`spaces/${c.req.valid("param").spaceId}/messages`), c.req.valid("query"))
      url.searchParams.set("orderBy", "createTime desc")
      return execute(c, MESSAGES_READ, url, messageListSchema)
    },
  )

  chat.post(
    `${base}/chat-spaces/:spaceId/messages`,
    route("sendGoogleChatMessage", "Send a message to an existing Google Chat space or direct message", "Posts one text message as the member after explicit user confirmation. It cannot create a space or start a new direct message. Never automatically retry an uncertain send.", messageSchema),
    orgMemberRoute(), boundedBody, paramValidator(spaceParams), jsonValidator(sendBody),
    async (c) => {
      const { spaceId } = c.req.valid("param")
      const { text, threadName } = c.req.valid("json")
      if (threadName && !threadName.startsWith(`spaces/${spaceId}/threads/`)) {
        return c.json({ error: "invalid_request", message: "threadName must belong to the same space." }, 400)
      }
      const url = chatUrl(`spaces/${spaceId}/messages`)
      if (threadName) url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD")
      return execute(c, MESSAGES_CREATE, url, messageSchema, {
        method: "POST", body: JSON.stringify({ text, ...(threadName ? { thread: { name: threadName } } : {}) }),
      })
    },
  )
  app.route("/", chat)
}
