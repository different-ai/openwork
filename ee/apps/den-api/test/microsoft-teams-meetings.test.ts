import assert from "node:assert/strict"
import { test } from "node:test"
import { InvalidEventTranscriptError, readMicrosoftEventTranscript, selectEventTranscripts, TRANSCRIPT_EVENT_TOLERANCE_MS } from "../src/capability-sources/microsoft-event-transcript.js"
import { isGraphTranscriptAccessDisabled, MicrosoftGraphClient, MicrosoftGraphRequestError, MicrosoftGraphTranscriptListIncompleteError, microsoftGraphErrorCodes, sliceTranscript } from "../src/capability-sources/microsoft-graph.js"

const BASE = "https://graph.example.com/v1.0"
const JOIN = "https://teams.microsoft.com/l/meetup-join/fixture-paper-astronomy?paper=it's%20blue"
const EVENT_ID = "event-paper-astronomy"
const MEETING_ID = "meeting-paper-astronomy"
const LIST_PATH = `/me/onlineMeetings/${MEETING_ID}/transcripts`
const EVENT = {
  id: EVENT_ID, subject: "Paper planetarium rehearsal", type: "occurrence", seriesMasterId: "series-paper-astronomy",
  start: { dateTime: "2041-07-10T12:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2041-07-10T15:00:00+02:00", timeZone: "UTC" },
  isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness", onlineMeeting: { joinUrl: JOIN },
}
const eventWindow = { start: "2041-07-10T12:00:00.000Z", end: "2041-07-10T13:00:00.000Z" }
const metadata = { id: EVENT_ID, subject: EVENT.subject, ...eventWindow }
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Jordan Sample>The cardboard moon needs a handle.</v>\n\n00:00:04.000 --> 00:00:06.000\n<v Riley Placeholder>I'll fold a spare constellation.</v>\n"
const PLAIN = "00:00:01.000 --> 00:00:03.000\nThe cardboard moon needs a handle.\n"
const TOKEN = "synthetic-paper-access"

function item(id: string, createdDateTime: string, endDateTime = "") {
  return { id, meetingId: MEETING_ID, createdDateTime, endDateTime }
}
const early = item("paper-early", "2041-07-03T12:00:00Z")
const target = item("paper-current", "2041-07-10T12:00:00Z", "2041-07-10T12:05:00Z")
const second = item("paper-second", "2041-07-10T12:15:00Z")
const late = item("paper-late", "2041-07-17T12:00:00Z")
const request = { eventId: EVENT_ID, maxCharacters: 15_000 }

type Seen = { url: URL; path: string; headers: Headers }
type Responses = { event?: object; meetings?: object[]; listing?: (call: Seen, page: number) => object; content?: (call: Seen) => Response; maxDownloadBytes?: number }

function fixture(options: Responses = {}) {
  const calls: Seen[] = []
  let page = 0
  const graph = new MicrosoftGraphClient({
    accessToken: TOKEN, baseUrl: BASE, maxDownloadBytes: options.maxDownloadBytes,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      assert.equal(url.origin, new URL(BASE).origin)
      assert.equal(init?.redirect, "error")
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`)
      const path = url.pathname.replace(/^\/v1\.0/, "")
      const call = { url, path, headers }
      calls.push(call)
      if (path === `/me/events/${EVENT_ID}`) return Response.json(options.event ?? EVENT)
      if (path === "/me/onlineMeetings") return Response.json({ value: options.meetings ?? [{ id: MEETING_ID }] })
      if (path === LIST_PATH) return Response.json(options.listing?.(call, ++page) ?? { value: [early, target, late] })
      if (path.startsWith(`${LIST_PATH}/`) && path.endsWith("/content")) return options.content?.(call) ?? new Response(VTT.replaceAll("\n", "\r\n"))
      assert.fail(`Unexpected Graph path: ${path}`)
    },
  })
  return { graph, calls, contentCalls: () => calls.filter(({ path }) => path.endsWith("/content")) }
}

function graphFailure(status: number, code: string) {
  return Response.json({ error: { code: "Forbidden", message: "Synthetic upstream failure.", innerError: { code } } }, { status })
}

test("event loading requests the transcript fields and UTC, normalizing bare times and explicit offsets", async () => {
  const { graph, calls } = fixture()
  assert.deepEqual(await graph.getCalendarEventForTranscript(EVENT_ID), {
    ...metadata, type: "occurrence", isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness", joinUrl: JOIN,
  })
  assert.equal(calls[0]?.headers.get("prefer"), 'outlook.timezone="UTC"')
  assert.equal(calls[0]?.url.searchParams.get("$select"), "id,subject,start,end,type,seriesMasterId,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,onlineMeetingUrl")
  const broken = fixture({ event: { ...EVENT, end: { dateTime: "unparseable", timeZone: "UTC" } } })
  await assert.rejects(readMicrosoftEventTranscript(broken.graph, request), MicrosoftGraphRequestError)
  assert.equal(broken.calls.length, 1)
})

test("meeting lookup passes the escaped link as one OData filter on the member's meetings", async () => {
  const { graph, calls } = fixture()
  assert.equal((await graph.findTeamsMeetingByJoinUrl(JOIN))?.id, MEETING_ID)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.path, "/me/onlineMeetings")
  const params = calls[0]?.url.searchParams
  assert.ok(params)
  assert.deepEqual([...params.entries()], [["$filter", `JoinWebUrl eq '${JOIN.replaceAll("'", "''")}'`]])
})

test("listing keeps the full same-origin, same-path next link and reads until the last page", async () => {
  const next = `${BASE}${LIST_PATH}?$top=50&$skiptoken=paper%2Btoken&extra=kept`
  const { graph, calls } = fixture({ listing: (_call, page) => page === 1 ? { value: [early], "@odata.nextLink": next } : { value: [target, late] } })
  assert.deepEqual(await graph.listTeamsMeetingTranscripts(MEETING_ID), [early, target, late])
  assert.equal(calls[0]?.url.searchParams.get("$top"), "50")
  assert.equal(calls[1]?.url.href, next)
})

for (const { name, makeLink, pages } of [
  { name: "foreign origin", makeLink: () => `https://other.example.com/v1.0${LIST_PATH}?$skiptoken=paper`, pages: 1 },
  { name: "different path", makeLink: () => `${BASE}/me/messages?$skiptoken=paper`, pages: 1 },
  { name: "invalid link", makeLink: () => "not an absolute URL", pages: 1 },
  { name: "page cap", makeLink: (page: number) => `${BASE}${LIST_PATH}?$skiptoken=${page}`, pages: 10 },
]) {
  test(`an incomplete list (${name}) does not read any transcript content`, async () => {
    const { graph, calls, contentCalls } = fixture({ listing: (_call, page) => ({ value: [target], "@odata.nextLink": makeLink(page) }) })
    await assert.rejects(readMicrosoftEventTranscript(graph, request), MicrosoftGraphTranscriptListIncompleteError)
    assert.equal(calls.filter(({ path }) => path === LIST_PATH).length, pages)
    assert.equal(contentCalls().length, 0)
  })
}

test("the tenth page is accepted if it completes the transcript list", async () => {
  const { graph, calls } = fixture({ listing: (_call, page) => page < 10 ? { value: [], "@odata.nextLink": `${BASE}${LIST_PATH}?$skiptoken=${page}` } : { value: [target] } })
  assert.deepEqual(await graph.listTeamsMeetingTranscripts(MEETING_ID), [target])
  assert.equal(calls.length, 10)
})

test("selection uses inclusive interval overlap, thirty minutes of tolerance, and chronological order", () => {
  assert.equal(TRANSCRIPT_EVENT_TOLERANCE_MS, 1_800_000)
  const crossing = item("paper-crossing", "2041-07-10T11:00:00Z", "2041-07-10T11:30:00Z")
  const before29 = item("paper-before-29", "2041-07-10T11:31:00Z")
  const before31 = item("paper-before-31", "2041-07-10T11:29:00Z")
  const after29 = item("paper-after-29", "2041-07-10T13:29:00Z")
  const after30 = item("paper-after-30", "2041-07-10T13:30:00Z")
  const after31 = item("paper-after-31", "2041-07-10T13:31:00Z")
  assert.deepEqual(selectEventTranscripts(eventWindow, [after31, target, after30, after29, before31, before29, crossing]), [crossing, before29, target, after29, after30])
  assert.deepEqual(selectEventTranscripts(eventWindow, [second, target]), [target, second])
})

test("selection uses the creation instant for bad ends and never matches a bad creation time", () => {
  for (const end of ["", "not a date", "2041-07-10T10:00:00Z", "2041-07-11T12:00:01Z"]) {
    const inside = item("paper-inside", "2041-07-10T12:00:00Z", end)
    const outside = item("paper-outside", "2041-07-10T11:20:00Z", end)
    assert.deepEqual(selectEventTranscripts(eventWindow, [outside, inside]), [inside])
  }
  const bad = item("paper-bad-date", "not a date", target.endDateTime)
  const exactly24h = item("paper-day-window", "2041-07-09T12:00:00Z", "2041-07-10T12:00:00Z")
  const over24h = item("paper-overlong-window", "2041-07-09T12:00:00Z", "2041-07-10T12:00:01Z")
  assert.deepEqual(selectEventTranscripts(eventWindow, [bad, over24h, exactly24h]), [exactly24h])
})

for (const { name, event, status } of [
  { name: "series master", event: { ...EVENT, type: "seriesMaster" }, status: "recurring_series" },
  { name: "offline event", event: { ...EVENT, isOnlineMeeting: false }, status: "not_teams_meeting" },
  { name: "no join link", event: { ...EVENT, onlineMeeting: null }, status: "not_teams_meeting" },
  { name: "non-Teams provider", event: { ...EVENT, onlineMeetingProvider: "skypeForBusiness" }, status: "not_teams_meeting" },
  { name: "non-Teams link", event: { ...EVENT, onlineMeeting: { joinUrl: "https://example.com/fixture-paper-astronomy" } }, status: "not_teams_meeting" },
]) {
  test(`the orchestrator stops at the calendar: ${name}`, async () => {
    const { graph, calls } = fixture({ event })
    const result = await readMicrosoftEventTranscript(graph, request)
    assert.ok(result.status === "recurring_series" || result.status === "not_teams_meeting")
    assert.equal(result.status, status)
    assert.deepEqual(result.event, metadata)
    assert.equal(result.retryable, false)
    assert.ok(result.message)
    assert.equal(calls.length, 1)
  })
}

test("a missing Graph meeting returns a distinct reason; the legacy event join link can be used", async () => {
  const { graph, calls } = fixture({ event: { ...EVENT, onlineMeetingProvider: undefined, onlineMeeting: null, onlineMeetingUrl: JOIN }, meetings: [] })
  const result = await readMicrosoftEventTranscript(graph, request)
  assert.ok(result.status === "no_transcript")
  assert.equal(result.reason, "meeting_not_found")
  assert.match(result.message, /does not show whether the meeting was recorded/)
  assert.equal(calls.length, 2)
})

test("transcripts from other occurrences are neither read nor selectable", async () => {
  const { graph, contentCalls } = fixture({ listing: () => ({ value: [early, late] }) })
  const result = await readMicrosoftEventTranscript(graph, request)
  assert.ok(result.status === "no_transcript")
  assert.equal(result.reason, "no_transcript_for_event")
  assert.match(result.message, /does not show whether the meeting was recorded/)
  await assert.rejects(readMicrosoftEventTranscript(graph, { ...request, transcriptId: early.id }), InvalidEventTranscriptError)
  assert.equal(contentCalls().length, 0)
})

test("the only matching transcript is read with normalized WebVTT and its metadata", async () => {
  const { graph, contentCalls } = fixture()
  assert.deepEqual(await readMicrosoftEventTranscript(graph, request), {
    ok: true, status: "transcript", event: metadata, transcript: {
      id: target.id, createdDateTime: target.createdDateTime, endDateTime: target.endDateTime,
      format: "vtt", speakerAttribution: true, content: VTT, totalCharacters: VTT.length, nextPageToken: null, contentUnavailableReason: null,
    },
  })
  assert.deepEqual(contentCalls().map(({ path }) => path), [`${LIST_PATH}/${target.id}/content`])
})

test("two matches require a choice; a chosen match can be read, but an id outside the window is rejected", async () => {
  const { graph, contentCalls } = fixture({ listing: () => ({ value: [second, early, target, late] }) })
  const choice = await readMicrosoftEventTranscript(graph, request)
  assert.ok(choice.status === "choose_transcript")
  assert.deepEqual(choice.candidates, [target, second].map(({ id, createdDateTime, endDateTime }) => ({ id, createdDateTime, endDateTime })))
  assert.match(choice.message, /transcriptId/)
  await assert.rejects(readMicrosoftEventTranscript(graph, { ...request, transcriptId: early.id }), InvalidEventTranscriptError)
  assert.equal(contentCalls().length, 0)
  const result = await readMicrosoftEventTranscript(graph, { ...request, transcriptId: second.id, pageToken: "8" })
  assert.ok(result.status === "transcript")
  assert.equal(result.transcript.id, second.id)
  assert.equal(result.transcript.content, VTT.slice(8))
  assert.deepEqual(contentCalls().map(({ path }) => path), [`${LIST_PATH}/${second.id}/content`])
})

test("speaker attribution falls back only for HTTP 403 with the expected Graph code", async () => {
  const permitted = fixture({ content: ({ headers }) => headers.get("accept") === "text/vtt" ? graphFailure(403, "SpeakerAttributionNotAllowed") : new Response(PLAIN) })
  const result = await readMicrosoftEventTranscript(permitted.graph, request)
  assert.ok(result.status === "transcript")
  assert.deepEqual([result.transcript.format, result.transcript.speakerAttribution, result.transcript.content], ["text", false, PLAIN])
  assert.deepEqual(permitted.contentCalls().map(({ headers }) => headers.get("accept")), ["text/vtt", "application/vnd.microsoft.graph.transcript+text"])
  for (const status of [400, 500]) {
    const other = fixture({ content: () => graphFailure(status, "SpeakerAttributionNotAllowed") })
    await assert.rejects(readMicrosoftEventTranscript(other.graph, request), MicrosoftGraphRequestError)
    assert.equal(other.contentCalls().length, 1)
  }
})

test("tenant policy blocks are typed and are never retried without speakers", async () => {
  const { graph, contentCalls } = fixture({ content: () => graphFailure(403, "GraphAccessToTranscriptsDisabled") })
  await assert.rejects(readMicrosoftEventTranscript(graph, request), (error: unknown) => {
    assert.equal(isGraphTranscriptAccessDisabled(error), true)
    assert.deepEqual(microsoftGraphErrorCodes(error), { status: 403, code: "Forbidden", innerCode: "GraphAccessToTranscriptsDisabled" })
    return true
  })
  assert.equal(contentCalls().length, 1)
})

test("a transcript exceeding the byte cap returns no partial text", async () => {
  const { graph } = fixture({ maxDownloadBytes: 1_024, content: () => new Response(VTT.repeat(50)) })
  const result = await readMicrosoftEventTranscript(graph, request)
  assert.ok(result.status === "transcript")
  assert.deepEqual([result.transcript.content, result.transcript.totalCharacters, result.transcript.nextPageToken, result.transcript.contentUnavailableReason], ["", 0, null, "transcript_too_large"])
})

test("paging preserves whole cues and surrogate pairs and enforces the character cap", async () => {
  const pages: string[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page: ReturnType<typeof sliceTranscript> = sliceTranscript(VTT, offset, 90)
    assert.ok(page.content.length > 0 && page.content.length <= 90)
    pages.push(page.content)
    offset = page.nextOffset
  }
  assert.deepEqual(pages, ["WEBVTT\n\n", ...VTT.slice(8).split(/(?<=\n\n)/)])
  assert.equal(pages.join(""), VTT)
  const prefix = "x".repeat(69)
  const suffix = "🪐" + "y".repeat(20)
  assert.deepEqual(sliceTranscript(prefix + suffix, 0, 70), { content: prefix, nextOffset: 69 })
  assert.deepEqual(sliceTranscript(prefix + suffix, 69, 70), { content: suffix, nextOffset: null })
  assert.deepEqual(sliceTranscript(VTT, VTT.length + 10, 70), { content: "", nextOffset: null })
  const { graph } = fixture({ content: () => new Response("x".repeat(20_000)) })
  const result = await readMicrosoftEventTranscript(graph, { ...request, maxCharacters: 20_000 })
  assert.ok(result.status === "transcript")
  assert.equal(result.transcript.content.length, 18_000)
  assert.equal(result.transcript.nextPageToken, "18000")
})
