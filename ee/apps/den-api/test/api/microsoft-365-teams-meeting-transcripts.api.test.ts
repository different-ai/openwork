import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const base = "/v1/capabilities/microsoft-365"
const operation = "readMicrosoft365CalendarEventTranscript"
const capability = `native:microsoft-365:${operation}`
const calendarScope = "Calendars.Read"
const meetingScope = "OnlineMeetings.Read"
const transcriptScope = "OnlineMeetingTranscript.Read.All"
const features = ["calendarRead", "teamsTranscriptRead"]
const scopes = [calendarScope, meetingScope, transcriptScope]
const tenantId = "11111111-2222-4333-8444-555555555555"
const tokenValue = "synthetic-kite-access"
const joinUrl = "https://teams.microsoft.com/l/meetup-join/fixture-kite-repair"
const sentinel = "saffron-filter-sentinel"
const meetingId = "kite-weekly-meeting"
const alternateMeetingId = "kite-alternate-meeting"
const blockedMeetingId = "kite-blocked-meeting"
const incompleteMeetingId = "kite-incomplete-meeting"
const occurrenceId = "kite-weekly-occurrence"
const choiceId = "kite-choice-occurrence"
const otherWeekId = "kite-untranscribed-occurrence"
const offlineId = "kite-offline-event"
const seriesId = "kite-series-master"
const blockedId = "kite-blocked-event"
const badFilterId = "kite-filter-event"
const incompleteId = "kite-incomplete-event"
const longId = "kite-long-occurrence"
const listPath = `/me/onlineMeetings/${meetingId}/transcripts`
const alternateListPath = `/me/onlineMeetings/${alternateMeetingId}/transcripts`
const subject = "Weekend kite repair circle"
const firstLine = "The striped kite needs a paper tail."
const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Jordan Sample>${firstLine}</v>\n\n00:00:04.000 --> 00:00:07.000\n<v Riley Placeholder>I brought a spool of yellow ribbon.</v>\n`
const longVtt = `WEBVTT\n\n${Array.from({ length: 600 }, (_, cue) => {
  const time = `00:${String(Math.floor(cue / 60)).padStart(2, "0")}:${String(cue % 60).padStart(2, "0")}`
  return `${time}.000 --> ${time}.900\n<v Riley Placeholder>Ribbon color sample ${cue} is pinned to the paper kite.</v>\n`
}).join("\n")}`

function transcript(id: string, date: string, time = "09:02:00") {
  return { id, createdDateTime: `${date}T${time}Z`, endDateTime: `${date}T09:22:00Z` }
}
const earlier = transcript("kite-transcript-earlier", "2043-06-04")
const current = transcript("kite-transcript-current", "2043-06-11")
const later = transcript("kite-transcript-later", "2043-06-18")
const choiceA = transcript("kite-transcript-choice-a", "2043-06-25")
const choiceB = transcript("kite-transcript-choice-b", "2043-06-25", "09:12:00")
const long = transcript("kite-transcript-long", "2043-07-09")

function event(id: string, date: string, options: { type?: string; link?: string | null } = {}) {
  const link = options.link === undefined ? joinUrl : options.link
  return {
    id, subject, type: options.type ?? "occurrence", seriesMasterId: seriesId,
    start: { dateTime: `${date}T09:00:00.0000000`, timeZone: "UTC" },
    end: { dateTime: `${date}T09:30:00.0000000`, timeZone: "UTC" },
    isOnlineMeeting: Boolean(link), onlineMeetingProvider: link ? "teamsForBusiness" : "unknown",
    onlineMeeting: link ? { joinUrl: link } : null,
  }
}
const occurrence = event(occurrenceId, "2043-06-11")
const events = new Map([
  [occurrenceId, occurrence], [choiceId, event(choiceId, "2043-06-25", { link: `${joinUrl}?mode=fixture-alternate` })],
  [otherWeekId, event(otherWeekId, "2043-07-02")],
  [offlineId, event(offlineId, "2043-06-11", { type: "singleInstance", link: null })],
  [seriesId, event(seriesId, "2043-06-11", { type: "seriesMaster" })],
  [blockedId, event(blockedId, "2043-06-11", { link: `${joinUrl}?mode=fixture-blocked` })],
  [badFilterId, event(badFilterId, "2043-06-11", { link: `${joinUrl}?mode=${sentinel}` })],
  [incompleteId, event(incompleteId, "2043-06-11", { link: `${joinUrl}?mode=fixture-incomplete` })],
  [longId, event(longId, "2043-07-09", { link: `${joinUrl}?mode=fixture-alternate` })],
])

const calls: { path: string; authorization: string | undefined }[] = []
const graph = await startFakeHttpServer((request, _body, response) => {
  const url = new URL(request.url ?? "/", "http://example.com")
  const path = url.pathname.replace(/^\/v1\.0/, "")
  calls.push({ path, authorization: request.headers.authorization })
  const json = (status: number, payload: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload))
  const content = (text: string) => response.writeHead(200, { "content-type": "text/vtt" }).end(text)
  if (path === "/me/chats") return json(200, { value: [] })
  if (path === "/me/calendarView") return json(200, { value: [occurrence] })
  if (path.startsWith("/me/events/")) {
    const selected = events.get(path.slice("/me/events/".length))
    if (selected) return json(200, selected)
  }
  if (path === "/me/onlineMeetings") {
    const filter = url.searchParams.get("$filter")
    if (filter?.includes(sentinel)) return json(400, { error: { code: "BadRequest", message: `Invalid filter: ${filter}` } })
    const meetingIds = new Map([
      [joinUrl, meetingId], [`${joinUrl}?mode=fixture-alternate`, alternateMeetingId],
      [`${joinUrl}?mode=fixture-blocked`, blockedMeetingId], [`${joinUrl}?mode=fixture-incomplete`, incompleteMeetingId],
    ])
    const id = [...meetingIds].find(([link]) => filter === `JoinWebUrl eq '${link}'`)?.[1]
    return json(200, { value: id ? [{ id }] : [] })
  }
  if (path === listPath) return json(200, { value: [later, earlier, current] })
  if (path === alternateListPath) return json(200, { value: [choiceB, earlier, long, choiceA] })
  if (path === `/me/onlineMeetings/${blockedMeetingId}/transcripts`) return json(403, { error: { code: "Forbidden", innerError: { code: "GraphAccessToTranscriptsDisabled" } } })
  if (path === `/me/onlineMeetings/${incompleteMeetingId}/transcripts`) return json(200, { value: [current], "@odata.nextLink": "https://example.com/fixture-next-page" })
  if (path === `${listPath}/${current.id}/content` || path === `${alternateListPath}/${choiceB.id}/content`) return content(vtt)
  if (path === `${alternateListPath}/${long.id}/content`) return content(longVtt)
  return json(404, { error: { code: "NotFound" } })
})
after(() => graph.close())
const den = await bootDen({ env: { DEN_MICROSOFT_GRAPH_BASE_URL: `${graph.url}/v1.0`, DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { upsertConnectedAccount, upsertOrgOAuthClient } = await import("../../src/capability-sources/oauth-credentials.js")
const { getNativeOAuthProvider, resolveProviderScopes } = await import("../../src/capability-sources/provider-registry.js")
const { orgId, owner } = await den.createOrg(await den.signUp("Jordan Sample"), "Synthetic Kite Workshop")
const api = den.as(owner, orgId)
const key = { organizationId: normalizeDenTypeId("organization", orgId), orgMembershipId: normalizeDenTypeId("member", owner.memberId), providerId: "microsoft-365" }

async function connect(selected = features, granted = scopes) {
  await upsertOrgOAuthClient({ ...key, clientId: "synthetic-kite-client", createdByOrgMembershipId: key.orgMembershipId, extra: { features: selected, tenantId } })
  await upsertConnectedAccount({ ...key, accessToken: tokenValue, tokenType: "Bearer", scopes: granted, expiresAt: new Date(Date.now() + 3_600_000) })
}

function route(eventId = occurrenceId, query = "") {
  return `${base}/calendar-events/${encodeURIComponent(eventId)}/transcript${query}`
}

function contentPaths() {
  return calls.filter(({ path }) => path.endsWith("/content")).map(({ path }) => path)
}

async function legacyTools(token: string) {
  const listed = await den.request(token, "POST", "/mcp", {
    headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  })
  assert.equal(listed.status, 200, summary(listed))
  assert.match(listed.text, /Microsoft365TeamsChats/)
  return listed.text
}

async function searchTranscripts(token: string) {
  const found = await den.callMcpTool(token, "search_capabilities", { query: "Teams meeting transcript", type: "api", limit: 20 })
  assert.equal(found.status, 200)
  assert.equal(found.isError, false, found.text)
  return list(field(found.structured ?? found.body, "matches"))
    .filter(({ name, path }) => typeof name === "string" && name.startsWith("native:microsoft-365:") && typeof path === "string" && path.includes("transcript"))
    .map(({ name }) => name)
}

beforeEach(() => { calls.length = 0 })

test("transcript scopes are opt-in and both are requested when selected", () => {
  const provider = getNativeOAuthProvider("microsoft-365")
  assert.ok(provider)
  const defaults = resolveProviderScopes(provider, provider.defaultFeatures ?? [])
  assert.equal(defaults.includes(meetingScope) || defaults.includes(transcriptScope), false)
  const chosen = resolveProviderScopes(provider, features)
  assert.deepEqual(chosen.filter((scope) => scope.startsWith("OnlineMeeting")), [meetingScope, transcriptScope])
})

test("flag off blocks the route and both MCP surfaces without affecting calendar or chats", async () => {
  await connect([...features, "teamsChatRead"], [...scopes, "Chat.Read"])
  for (const path of [route(), route("fixture/bad-path", "?pageToken=invalid")]) {
    const denied = await api("GET", path)
    assert.equal(denied.status, 404, summary(denied))
    assert.deepEqual(denied.body, { error: "feature_disabled", feature: "teamsMeetingTranscripts" })
  }
  const token = await den.mintMcpToken(owner, orgId)
  assert.deepEqual(await searchTranscripts(token), [])
  const refused = await den.callMcpTool(token, "execute_capability", { name: capability, path: { eventId: occurrenceId } })
  assert.equal(refused.isError, true)
  assert.doesNotMatch(await legacyTools(token), /Microsoft365CalendarEventTranscript/)
  assert.equal(calls.length, 0)
  const calendar = await api("GET", `${base}/calendar-events?timeMin=2043-06-11T00:00:00Z&timeMax=2043-06-12T00:00:00Z`)
  assert.equal(calendar.status, 200, summary(calendar))
  assert.deepEqual(list(field(calendar.body, "events")).map(({ id }) => id), [occurrenceId])
  const chats = await api("GET", `${base}/teams-chats`)
  assert.equal(chats.status, 200, summary(chats))
  assert.deepEqual(chats.body, { ok: true, chats: [], nextPageToken: null, hasMore: false })
  assert.deepEqual(calls.map(({ path }) => path), ["/me/calendarView", "/me/chats"])
  const enabled = await den.setFeature(orgId, "teamsMeetingTranscripts", true)
  assert.equal(enabled.status, 200, summary(enabled))
})

test("turning transcripts on leaves the other Microsoft 365 read resources off", async () => {
  for (const path of ["/profile", "/mail-folders", "/teams"]) {
    const resource = await api("GET", `${base}${path}`)
    assert.equal(resource.status, 404, summary(resource))
    assert.deepEqual(resource.body, { error: "feature_disabled", feature: "microsoft365ReadResources" })
  }
  const token = await den.mintMcpToken(owner, orgId)
  const found = await den.callMcpTool(token, "search_capabilities", { query: "Microsoft 365 profile mail folders teams", type: "api", limit: 20 })
  assert.equal(list(field(found.structured ?? found.body, "matches")).some((match) => /getMicrosoft365Profile|listMicrosoft365MailFolders|listMicrosoft365JoinedTeams/.test(String(match.name))), false)
})

test("unsigned callers and callers missing either permission or any required scope never reach Graph", async () => {
  const unsigned = await den.request(null, "GET", route(), { orgId })
  assert.equal(unsigned.status, 401, summary(unsigned))
  for (const { selected, granted, message } of [
    { selected: ["teamsTranscriptRead"], granted: scopes, message: /administrator has disabled Outlook calendar read/ },
    { selected: ["calendarRead"], granted: scopes, message: /administrator has disabled Teams meeting transcript read/ },
    { selected: features, granted: [meetingScope, transcriptScope], message: /missing the Outlook calendar read permission/ },
    { selected: features, granted: [calendarScope, transcriptScope], message: /missing the Teams meeting transcript read permission/ },
    { selected: features, granted: [calendarScope, meetingScope], message: /missing the Teams meeting transcript read permission/ },
  ]) {
    await connect(selected, granted)
    const denied = await api("GET", route())
    assert.equal(denied.status, 409, summary(denied))
    assert.equal(field(denied.body, "error"), "needs_connection")
    assert.match(String(field(denied.body, "message")), message)
    assert.equal(calls.length, 0)
  }
})

test("input validation rejects path ids, malformed offsets and invalid page sizes", async () => {
  await connect()
  for (const path of [route("fixture/bad-path"), route(occurrenceId, "?transcriptId=fixture%2Fbad"), route(occurrenceId, "?pageToken=-1"), route(occurrenceId, "?pageToken=123456789"), route(occurrenceId, "?maxCharacters=999"), route(occurrenceId, "?maxCharacters=18001")]) {
    const invalid = await api("GET", path)
    assert.equal(invalid.status, 400, summary(invalid))
  }
  assert.equal(calls.length, 0)
})

test("a recurring occurrence reads only the matching transcript and returns the calendar event in UTC", async () => {
  await connect()
  const read = await api("GET", route())
  assert.equal(read.status, 200, summary(read))
  assert.deepEqual(read.body, { ok: true, status: "transcript", event: {
    id: occurrenceId, subject, start: "2043-06-11T09:00:00.000Z", end: "2043-06-11T09:30:00.000Z",
  }, transcript: {
    ...current, format: "vtt", speakerAttribution: true, content: vtt, totalCharacters: vtt.length, nextPageToken: null, contentUnavailableReason: null,
  } })
  assert.deepEqual(calls.map(({ path }) => path), [`/me/events/${occurrenceId}`, "/me/onlineMeetings", listPath, `${listPath}/${current.id}/content`])
  assert.equal(calls.every(({ authorization }) => authorization === `Bearer ${tokenValue}`), true)
})

test("multiple matches require a choice and ids from other occurrences are rejected", async () => {
  await connect()
  const choose = await api("GET", route(choiceId))
  assert.equal(choose.status, 200, summary(choose))
  assert.equal(field(choose.body, "status"), "choose_transcript")
  assert.deepEqual(field(choose.body, "candidates"), [choiceA, choiceB])
  assert.match(String(field(choose.body, "message")), /transcriptId/)
  const wrong = await api("GET", route(choiceId, `?transcriptId=${earlier.id}`))
  assert.equal(wrong.status, 400, summary(wrong))
  assert.equal(field(wrong.body, "error"), "invalid_request")
  assert.deepEqual(contentPaths(), [])
  const read = await api("GET", route(choiceId, `?transcriptId=${choiceB.id}`))
  assert.equal(read.status, 200, summary(read))
  assert.equal(field(read.body, "status"), "transcript")
  assert.equal(field(read.body, "transcript", "content"), vtt)
  assert.deepEqual(contentPaths(), [`${alternateListPath}/${choiceB.id}/content`])
})

test("no transcript, offline events, and series masters return plain explanations without reading content", async () => {
  await connect()
  const none = await api("GET", route(otherWeekId))
  assert.equal(none.status, 200, summary(none))
  assert.equal(field(none.body, "status"), "no_transcript")
  assert.equal(field(none.body, "reason"), "no_transcript_for_event")
  assert.match(String(field(none.body, "message")), /does not show whether the meeting was recorded/)
  calls.length = 0
  for (const [eventId, status] of [[offlineId, "not_teams_meeting"], [seriesId, "recurring_series"]]) {
    assert.ok(eventId)
    const response = await api("GET", route(eventId))
    assert.equal(response.status, 200, summary(response))
    assert.equal(field(response.body, "status"), status)
    assert.equal(field(response.body, "retryable"), false)
    assert.ok(field(response.body, "message"))
  }
  assert.deepEqual(calls.map(({ path }) => path), [`/me/events/${offlineId}`, `/me/events/${seriesId}`])
})

test("Graph blocks and incomplete lists are not retryable; Graph error text and transcript content stay out of audit storage", async () => {
  await connect()
  assert.equal((await api("GET", route())).status, 200)
  calls.length = 0
  const blocked = await api("GET", route(blockedId))
  assert.equal(blocked.status, 502, summary(blocked))
  assert.equal(field(blocked.body, "error"), "microsoft_graph_error")
  assert.equal(field(blocked.body, "retryable"), false)
  assert.match(String(field(blocked.body, "message")), /Teams administrator has turned off/)
  const incomplete = await api("GET", route(incompleteId))
  assert.equal(incomplete.status, 502, summary(incomplete))
  assert.equal(field(incomplete.body, "error"), "microsoft_graph_error")
  assert.equal(field(incomplete.body, "retryable"), false)
  assert.match(String(field(incomplete.body, "message")), /more transcripts than could be listed/)
  assert.deepEqual(contentPaths(), [])
  const echoed = await api("GET", route(badFilterId))
  assert.equal(echoed.status, 502, summary(echoed))
  assert.match(String(field(echoed.body, "message")), /400 BadRequest/)
  for (const secret of [joinUrl, sentinel, tokenValue]) assert.equal(echoed.text.includes(secret), false)
  const audit = await den.auditStorageText()
  assert.match(audit, /capability\.teams\.meeting_transcript\.read/)
  for (const secret of [joinUrl, "fixture-kite-repair", sentinel, firstLine]) assert.equal(audit.includes(secret), false)
})

test("MCP discovers one transcript capability and reassembles a long transcript without truncation", async () => {
  await connect()
  const token = await den.mintMcpToken(owner, orgId)
  assert.deepEqual(await searchTranscripts(token), [capability])
  assert.match(await legacyTools(token), /Microsoft365CalendarEventTranscript/)
  assert.ok(longVtt.length > 40_000)
  const pages: string[] = []
  let pageToken: string | undefined
  do {
    assert.ok(pages.length < 10, "pagination did not terminate")
    const page = await den.callMcpTool(token, "execute_capability", {
      name: capability, path: { eventId: longId }, query: { maxCharacters: 18_000, ...(pageToken ? { pageToken } : {}) },
    })
    assert.equal(page.isError, false, page.text)
    assert.equal(field(page.body, "status"), "transcript")
    const content = field(page.body, "transcript", "content")
    const next = field(page.body, "transcript", "nextPageToken")
    assert.ok(typeof content === "string")
    assert.doesNotMatch(page.text, /\[truncated/)
    assert.ok((next === null || content.endsWith("</v>\n\n")) && content.length <= 18_000)
    assert.ok(next === null || typeof next === "string")
    pages.push(content)
    pageToken = next ?? undefined
  } while (pageToken)
  assert.ok(pages.length >= 3)
  assert.equal(pages.join(""), longVtt)
  assert.deepEqual(contentPaths(), pages.map(() => `${alternateListPath}/${long.id}/content`))
})
