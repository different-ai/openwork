import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isGraphTranscriptAccessDisabled,
  isTeamsJoinUrl,
  MicrosoftGraphClient,
  MicrosoftGraphRequestError,
  microsoftGraphErrorCodes,
  sliceTranscript,
} from "../src/capability-sources/microsoft-graph.js"

const BASE_URL = "https://graph.example.test/v1.0"
const TOKEN = "graph-access-token-fixture"
const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_Zml4dHVyZQ%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant%22%7d&it's=1"
const VTT = "WEBVTT\r\n\r\n00:00:04.000 --> 00:00:08.000\r\n<v Alex Example>We agreed to start with a pilot.</v>\r\n\r\n00:00:09.000 --> 00:00:12.000\r\n<v Morgan Example>I will prepare the list\r\nby Friday.</v>\r\n"

type Seen = { url: URL; accept: string; authorization: string; method: string }

function client(respond: (seen: Seen, count: number) => Response, options: { maxDownloadBytes?: number } = {}) {
  const calls: Seen[] = []
  const graph = new MicrosoftGraphClient({
    accessToken: TOKEN,
    baseUrl: BASE_URL,
    ...options,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      const seen = {
        url: new URL(input instanceof Request ? input.url : String(input)),
        accept: headers.get("accept") ?? "",
        authorization: headers.get("authorization") ?? "",
        method: init?.method ?? "GET",
      }
      calls.push(seen)
      return respond(seen, calls.length)
    },
  })
  return { graph, calls }
}

function graphFailure(status: number, innerCode: string) {
  return Response.json({ error: { code: "Forbidden", message: "Blocked.", innerError: { code: innerCode } } }, { status })
}

test("only https Teams join links are accepted", () => {
  for (const link of [
    JOIN_URL,
    "https://teams.microsoft.com/meet/123456789?p=abc",
    "https://teams.cloud.microsoft/l/meetup-join/19%3ameeting_x%40thread.v2/0",
    "https://gov.teams.microsoft.us/l/meetup-join/19%3ameeting_x%40thread.v2/0",
  ]) assert.equal(isTeamsJoinUrl(link), true, link)
  for (const link of [
    "http://teams.microsoft.com/l/meetup-join/x",
    "https://teams.microsoft.com.example.test/l/meetup-join/x",
    "https://example.test/?next=https://teams.microsoft.com/l/meetup-join/x",
    "https://user:secret@teams.microsoft.com/l/meetup-join/x",
    "https://teams.microsoft.com:8443/l/meetup-join/x",
    "https://teams.microsoft.com/l/meetup-join/x y",
    "https://169.254.169.254/latest/meta-data",
    "file:///etc/hosts",
    "teams.microsoft.com/l/meetup-join/x",
    "",
  ]) assert.equal(isTeamsJoinUrl(link), false, link)
})

test("a meeting lookup sends the join link once, as an escaped filter value on the member's own meetings", async () => {
  const { graph, calls } = client(() => Response.json({ value: [{
    id: "meeting-1", subject: "Planning sync", startDateTime: "2026-11-25T15:00:00Z", endDateTime: "2026-11-25T15:45:00Z", joinWebUrl: JOIN_URL,
    participants: { organizer: { upn: "organizer@example.test", identity: { user: { displayName: "Alex Example" } } } },
  }] }))
  assert.deepEqual(await graph.findTeamsMeetingByJoinUrl(JOIN_URL), {
    id: "meeting-1", subject: "Planning sync", startDateTime: "2026-11-25T15:00:00Z", endDateTime: "2026-11-25T15:45:00Z", joinWebUrl: JOIN_URL,
    organizer: { name: "Alex Example", address: "organizer@example.test" },
  })
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.ok(call)
  assert.equal(call.method, "GET")
  assert.equal(call.authorization, `Bearer ${TOKEN}`)
  assert.equal(`${call.url.origin}${call.url.pathname}`, `${BASE_URL}/me/onlineMeetings`)
  assert.deepEqual([...call.url.searchParams.keys()], ["$filter"])
  assert.equal(call.url.searchParams.get("$filter"), `JoinWebUrl eq '${JOIN_URL.replace("'", "''")}'`)
  assert.equal(call.url.search.includes("+"), false)
  assert.equal(call.url.search.includes("19%253ameeting"), true)
})

test("a meeting lookup with no match returns null and ignores entries without an id", async () => {
  for (const body of [{ value: [] }, { value: [{ subject: "No id" }, "text", null] }, {}, []]) {
    const { graph } = client(() => Response.json(body))
    assert.equal(await graph.findTeamsMeetingByJoinUrl(JOIN_URL), null)
  }
})

test("a transcript list encodes the meeting id, pages by Microsoft's token and reports when more remain", async () => {
  const { graph, calls } = client((_seen, count) => Response.json(count === 1
    ? {
        value: [{ id: "t-1", meetingId: "m/1", createdDateTime: "2026-11-18T15:00:10Z", endDateTime: "2026-11-18T15:40:00Z", transcriptContentUrl: "https://graph.example.test/elsewhere" }, { meetingId: "no id" }],
        "@odata.nextLink": `${BASE_URL}/me/onlineMeetings/m%2F1/transcripts?$top=1&$skiptoken=page-two`,
      }
    : { value: [{ id: "t-2", meetingId: "m/1", createdDateTime: "2026-11-25T15:00:05Z", endDateTime: "2026-11-25T15:44:00Z" }], "@odata.nextLink": `${BASE_URL}/me/onlineMeetings/m%2F1/transcripts?$skip=2` }))
  const first = await graph.listTeamsMeetingTranscripts({ meetingId: "m/1", maxResults: 1 })
  assert.deepEqual(first, {
    transcripts: [{ id: "t-1", meetingId: "m/1", createdDateTime: "2026-11-18T15:00:10Z", endDateTime: "2026-11-18T15:40:00Z" }],
    nextPageToken: "page-two", hasMore: true,
  })
  const second = await graph.listTeamsMeetingTranscripts({ meetingId: "m/1", maxResults: 1, pageToken: "page-two" })
  assert.deepEqual(second.transcripts.map((transcript) => transcript.id), ["t-2"])
  assert.deepEqual([second.nextPageToken, second.hasMore], [null, true])
  assert.equal(calls[0]?.url.pathname, "/v1.0/me/onlineMeetings/m%2F1/transcripts")
  assert.equal(calls[0]?.url.searchParams.get("$top"), "1")
  assert.equal(calls[0]?.url.searchParams.has("$skiptoken"), false)
  assert.equal(calls[1]?.url.searchParams.get("$skiptoken"), "page-two")
  assert.equal(calls.every((call) => call.url.origin === "https://graph.example.test"), true)
})

test("a transcript is read as WebVTT with speakers and cue times kept", async () => {
  const { graph, calls } = client(() => new Response(VTT, { headers: { "content-type": "text/vtt" } }))
  const transcript = await graph.getTeamsMeetingTranscriptContent({ meetingId: "m 1", transcriptId: "t#1", offset: 0, maxCharacters: 50_000 })
  const text = VTT.replace(/\r\n/g, "\n")
  assert.deepEqual(transcript, { format: "vtt", speakerAttribution: true, content: text, offset: 0, totalCharacters: text.length, nextOffset: null, contentUnavailableReason: null })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url.pathname, "/v1.0/me/onlineMeetings/m%201/transcripts/t%231/content")
  assert.equal(calls[0]?.url.search, "")
  assert.equal(calls[0]?.accept, "text/vtt")
})

test("long transcripts come back in pages that end on a whole cue and add up to the original", async () => {
  const text = VTT.replace(/\r\n/g, "\n")
  const pages: string[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page: { content: string; nextOffset: number | null } = sliceTranscript(text, offset, 70)
    assert.ok(page.content.length > 0 && page.content.length <= 70)
    pages.push(page.content)
    offset = page.nextOffset
  }
  assert.equal(pages.join(""), text)
  assert.ok(pages.length > 2)
  assert.equal(pages[0], "WEBVTT\n\n")
  assert.deepEqual(sliceTranscript(text, text.length + 5, 70), { content: "", nextOffset: null })
  assert.deepEqual(sliceTranscript("x".repeat(150), 0, 70), { content: "x".repeat(70), nextOffset: 70 })
  const emoji = `${"x".repeat(69)}\u{1F600}${"y".repeat(20)}`
  const beforeEmoji = sliceTranscript(emoji, 0, 70)
  assert.deepEqual(beforeEmoji, { content: "x".repeat(69), nextOffset: 69 })
  assert.equal(sliceTranscript(emoji, 69, 70).content, `\u{1F600}${"y".repeat(20)}`)

  const { graph } = client(() => new Response(VTT))
  const second = await graph.getTeamsMeetingTranscriptContent({ meetingId: "m", transcriptId: "t", offset: 8, maxCharacters: 90 })
  assert.equal(second.content.startsWith("00:00:04.000 --> 00:00:08.000\n<v Alex Example>"), true)
  assert.equal(second.content.endsWith("</v>\n\n"), true)
  assert.equal(second.nextOffset, 8 + second.content.length)
  assert.equal(second.totalCharacters, text.length)
})

test("when speaker names are not allowed, the transcript is requested again without them", async () => {
  const plain = "00:00:04.000 --> 00:00:08.000\nWe agreed to start with a pilot.\n"
  const { graph, calls } = client((seen) => seen.accept === "text/vtt"
    ? graphFailure(403, "SpeakerAttributionNotAllowed")
    : new Response(plain, { headers: { "content-type": "application/vnd.microsoft.graph.transcript+text" } }))
  const transcript = await graph.getTeamsMeetingTranscriptContent({ meetingId: "m", transcriptId: "t", offset: 0, maxCharacters: 50_000 })
  assert.deepEqual([transcript.format, transcript.speakerAttribution, transcript.content], ["text", false, plain])
  assert.deepEqual(calls.map((call) => call.accept), ["text/vtt", "application/vnd.microsoft.graph.transcript+text"])
  assert.equal(calls[0]?.url.href, calls[1]?.url.href)

  const other = client(() => graphFailure(500, "SpeakerAttributionNotAllowed"))
  const failure = await other.graph.getTeamsMeetingTranscriptContent({ meetingId: "m", transcriptId: "t", offset: 0, maxCharacters: 50_000 }).catch((error: unknown) => error)
  assert.ok(failure instanceof MicrosoftGraphRequestError)
  assert.equal(other.calls.length, 1)
})

test("a tenant that turned off transcript access is reported once, with Microsoft's code and no second request", async () => {
  const { graph, calls } = client(() => graphFailure(403, "GraphAccessToTranscriptsDisabled"))
  const failure = await graph.getTeamsMeetingTranscriptContent({ meetingId: "m", transcriptId: "t", offset: 0, maxCharacters: 50_000 }).catch((error: unknown) => error)
  assert.ok(failure instanceof MicrosoftGraphRequestError)
  assert.equal(failure.status, 403)
  assert.deepEqual(microsoftGraphErrorCodes(failure), { status: 403, code: "Forbidden", innerCode: "GraphAccessToTranscriptsDisabled" })
  assert.equal(isGraphTranscriptAccessDisabled(failure), true)
  assert.equal(failure.message.includes(TOKEN), false)
  assert.equal(calls.length, 1)
  assert.equal(isGraphTranscriptAccessDisabled(new MicrosoftGraphRequestError("op", 500, JSON.stringify({ error: { innerError: { code: "GraphAccessToTranscriptsDisabled" } } }))), false)
  assert.deepEqual(microsoftGraphErrorCodes(new MicrosoftGraphRequestError("op", 403, "not json")), { status: 403, code: "", innerCode: "" })
  assert.deepEqual(
    microsoftGraphErrorCodes(new MicrosoftGraphRequestError("op", 400, JSON.stringify({ error: { code: "Invalid filter: JoinWebUrl eq 'https://teams.microsoft.com/x'", innerError: { code: "BadRequest" } } }))),
    { status: 400, code: "", innerCode: "BadRequest" },
  )
  assert.equal(microsoftGraphErrorCodes(new Error("other")), null)
})

test("a transcript larger than the download limit returns no partial text", async () => {
  const { graph } = client(() => new Response("WEBVTT\n\n" + "x".repeat(4_096)), { maxDownloadBytes: 1_024 })
  const transcript = await graph.getTeamsMeetingTranscriptContent({ meetingId: "m", transcriptId: "t", offset: 0, maxCharacters: 50_000 })
  assert.deepEqual(transcript, { format: "vtt", speakerAttribution: true, content: "", offset: 0, totalCharacters: 0, nextOffset: null, contentUnavailableReason: "transcript_too_large" })
})
