import { Hono, type Context, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { isGraphTranscriptAccessDisabled, isTeamsJoinUrl, microsoftGraphErrorCodes, type MicrosoftGraphClient } from "../../capability-sources/microsoft-graph.js"
import { requireFeature } from "../../features.js"
import { paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { graphError, graphErrorStatus, graphItemIdSchema, needsConnectionSchema, upstreamErrorSchema, type Microsoft365Access } from "./microsoft-365-shared.js"
import type { OrgRouteVariables } from "./shared.js"

export const TEAMS_MEETINGS_FEATURE = "teamsMeetingTranscripts"
const TRANSCRIPT_READ: readonly string[] = ["teamsTranscriptRead"]
const TRANSCRIPT_LABEL = "Teams meeting transcript read"
export const TRANSCRIPT_PAGE_MAX_CHARACTERS = 18_000
const TRANSCRIPTS_OFF_MESSAGE = "A Microsoft Teams administrator has turned off Microsoft Graph access to meeting transcripts for this organization. Trying again will not help until they turn it back on in the Teams admin center."

const GRAPH_STATUS_HINTS: Record<number, string> = {
  403: " The member may not be on the meeting invitation, or an Entra administrator has not granted consent for meeting transcripts.",
  404: " Microsoft has no such meeting or transcript for this member; it may have expired or not come from a calendar event.",
  429: " Microsoft is limiting requests; wait before trying again.",
}

function transcriptGraphError(error: unknown): { status: 409 | 502; body: { error: "microsoft_graph_error" | "needs_connection"; message: string; outcome?: "unknown"; retryable?: false } } {
  if (isGraphTranscriptAccessDisabled(error)) return { status: 502, body: { error: "microsoft_graph_error", message: TRANSCRIPTS_OFF_MESSAGE, retryable: false } }
  const codes = microsoftGraphErrorCodes(error)
  if (!codes) return { status: graphErrorStatus(error), body: graphError(error) }
  const reason = [codes.code, codes.innerCode].filter(Boolean).join(", ")
  return { status: 502, body: {
    error: "microsoft_graph_error",
    message: `Microsoft Graph refused the Teams meeting request: ${codes.status}${reason ? ` ${reason}` : ""}.${GRAPH_STATUS_HINTS[codes.status] ?? ""}`,
  } }
}

const joinUrlSchema = z.string().trim().min(1).max(2048)
  .refine(isTeamsJoinUrl, "Use the meeting's Teams join link (https://teams.microsoft.com/...), such as onlineMeetingUrl from a calendar event.")

const meetingIdSchema = graphItemIdSchema.describe("Meeting id from the Teams meeting lookup. It is not a calendar event id.")

const meetingSchema = z.object({
  id: z.string().describe("Pass as meetingId to list this meeting's transcripts."),
  subject: z.string(),
  startDateTime: z.string(),
  endDateTime: z.string(),
  joinWebUrl: z.string(),
  organizer: z.object({ name: z.string(), address: z.string() }).nullable(),
}).meta({ ref: "Microsoft365TeamsMeeting" })

const transcriptSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  createdDateTime: z.string().describe("When this transcript started, in UTC. A recurring meeting has one transcript per occurrence that was transcribed."),
  endDateTime: z.string(),
}).meta({ ref: "Microsoft365TeamsTranscript" })

const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.literal(TEAMS_MEETINGS_FEATURE) })

const errors = {
  401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
  403: jsonResponse("The connection is blocked by organization policy.", z.object({ error: z.literal("policy_blocked"), message: z.string() })),
  404: jsonResponse("Teams meeting transcripts are turned off for this organization.", featureDisabledSchema),
  409: jsonResponse("The calling member has not connected their Microsoft account or is missing permission.", needsConnectionSchema),
  502: jsonResponse("Microsoft Graph rejected the request. retryable: false means a Teams administrator setting blocks transcripts.", upstreamErrorSchema),
}

export type MicrosoftTeamsMeetingRouteOptions = {
  access: Microsoft365Access
  memberRoute: MiddlewareHandler<{ Variables: OrgRouteVariables }>
}

export function registerMicrosoftTeamsMeetingRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, options: MicrosoftTeamsMeetingRouteOptions) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const featureOn = requireFeature(TEAMS_MEETINGS_FEATURE)

  async function withGraph(c: Context<{ Variables: OrgRouteVariables }>, run: (graph: MicrosoftGraphClient) => Promise<Response>) {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "unauthorized", message: "Sign in to an organization first." }, 401)
    const granted = await options.access({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, features: TRANSCRIPT_READ, label: TRANSCRIPT_LABEL })
    if (!granted.ok) return c.json(granted.body, granted.status)
    try {
      return await run(granted.graph({ signal: c.req.raw.signal }))
    } catch (error) {
      const failure = transcriptGraphError(error)
      return c.json(failure.body, failure.status)
    }
  }

  app.get("/v1/capabilities/microsoft-365/teams-meetings", describeRoute({
    operationId: "findMicrosoft365TeamsMeeting", tags: ["Capability Sources"],
    summary: "Find a Microsoft Teams meeting from its join link",
    description: "Returns the Teams meeting behind a join link, such as onlineMeetingUrl from a calendar event, when the calling member organized it or was invited. meeting is null when Microsoft finds none for this member. The link is only matched by Microsoft Graph, never opened. Use meeting.id to list its transcripts. Read-only.",
    responses: { 200: jsonResponse("The meeting, or null.", z.object({ ok: z.literal(true), meeting: meetingSchema.nullable() }).meta({ ref: "Microsoft365TeamsMeetingResponse" })), ...errors },
  }), options.memberRoute, featureOn, queryValidator(z.object({
    joinUrl: joinUrlSchema.describe("The meeting's Teams join link, exactly as the calendar event gives it."),
  })), (c) => withGraph(c, async (graph) => (
    c.json({ ok: true, meeting: await graph.findTeamsMeetingByJoinUrl(c.req.valid("query").joinUrl) })
  )))

  app.get("/v1/capabilities/microsoft-365/teams-meetings/:meetingId/transcripts", describeRoute({
    operationId: "listMicrosoft365TeamsMeetingTranscripts", tags: ["Capability Sources"],
    summary: "List the transcripts of a Microsoft Teams meeting",
    description: "Lists transcript ids and times for one Teams meeting, without their text. Every occurrence of a recurring meeting shares one meeting id, so match createdDateTime to the occurrence the user asked about and read only that transcript; ask when several could match. An empty list means no transcript is available to this member, not that the meeting was not recorded. hasMore with a null nextPageToken means the list is partial. Read-only.",
    responses: { 200: jsonResponse("Transcript ids and times.", z.object({
      ok: z.literal(true), transcripts: z.array(transcriptSchema), nextPageToken: z.string().nullable(), hasMore: z.boolean(),
    }).meta({ ref: "Microsoft365TeamsTranscriptsResponse" })), ...errors },
  }), options.memberRoute, featureOn, paramValidator(z.object({ meetingId: meetingIdSchema })), queryValidator(z.object({
    maxResults: z.coerce.number().int().min(1).max(50).default(20),
    pageToken: z.string().min(1).max(2048).optional().describe("nextPageToken from the previous page of the same meeting."),
  })), (c) => withGraph(c, async (graph) => (
    c.json({ ok: true, ...await graph.listTeamsMeetingTranscripts({ meetingId: c.req.valid("param").meetingId, ...c.req.valid("query") }) })
  )))

  app.get("/v1/capabilities/microsoft-365/teams-meetings/:meetingId/transcripts/:transcriptId", describeRoute({
    operationId: "readMicrosoft365TeamsMeetingTranscript", tags: ["Capability Sources"],
    summary: "Read a Microsoft Teams meeting transcript",
    description: "Returns one transcript's text in pages: WebVTT with cue times and <v Speaker> names, or timed text without speakers (speakerAttribution false) when the Teams administrator does not allow speaker names. Cue times are relative to the start of this transcript. Pass nextPageToken as pageToken until it is null before saying what the whole meeting covered. Quote speakers and times as written; never infer an owner or a date. Read-only.",
    responses: { 200: jsonResponse("One page of the transcript.", z.object({
      ok: z.literal(true),
      transcript: z.object({
        id: z.string(),
        meetingId: z.string(),
        format: z.enum(["vtt", "text"]),
        speakerAttribution: z.boolean(),
        content: z.string(),
        totalCharacters: z.number().int(),
        nextPageToken: z.string().nullable().describe("Pass as pageToken for the next page; null on the last page."),
        contentUnavailableReason: z.enum(["transcript_too_large"]).nullable(),
      }),
    }).meta({ ref: "Microsoft365TeamsTranscriptResponse" })), ...errors },
  }), options.memberRoute, featureOn, paramValidator(z.object({
    meetingId: meetingIdSchema,
    transcriptId: graphItemIdSchema.describe("Transcript id from the meeting's transcript list."),
  })), queryValidator(z.object({
    pageToken: z.string().regex(/^\d{1,8}$/).optional().describe("nextPageToken from the previous page of the same transcript."),
    maxCharacters: z.coerce.number().int().min(1_000).max(TRANSCRIPT_PAGE_MAX_CHARACTERS).default(15_000).describe("Most characters to return; a page ends on a whole cue when it can."),
  })), (c) => withGraph(c, async (graph) => {
    const { meetingId, transcriptId } = c.req.valid("param")
    const { pageToken, maxCharacters } = c.req.valid("query")
    const { offset: _offset, nextOffset, ...page } = await graph.getTeamsMeetingTranscriptContent({ meetingId, transcriptId, offset: pageToken ? Number(pageToken) : 0, maxCharacters })
    return c.json({ ok: true, transcript: { id: transcriptId, meetingId, ...page, nextPageToken: nextOffset === null ? null : String(nextOffset) } })
  }))

  routeApp.route("/", app)
}
