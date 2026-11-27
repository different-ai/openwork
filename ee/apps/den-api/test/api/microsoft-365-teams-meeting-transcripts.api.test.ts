import assert from "node:assert/strict"
import { after, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const base = "/v1/capabilities/microsoft-365"
const meetingsRead = "OnlineMeetings.Read"
const transcriptsRead = "OnlineMeetingTranscript.Read.All"
const joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_Zml4dHVyZQ%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant%22%7d"
const vtt = "WEBVTT\n\n00:00:04.000 --> 00:00:08.000\n<v Alex Example>We agreed to start with a pilot.</v>\n\n00:00:09.000 --> 00:00:12.000\n<v Morgan Example>I will prepare the list by Friday.</v>\n"
const longVtt = `WEBVTT\n\n${Array.from({ length: 600 }, (_, cue) => `00:${String(Math.floor(cue / 60)).padStart(2, "0")}:${String(cue % 60).padStart(2, "0")}.000 --> 00:${String(Math.floor(cue / 60)).padStart(2, "0")}:${String(cue % 60).padStart(2, "0")}.900\n<v Alex Example>Statement number ${cue} about the pilot plan.</v>\n`).join("\n")}`
const plain = "00:00:04.000 --> 00:00:08.000\nWe agreed to start with a pilot.\n"
const meeting = {
  id: "meeting-1", subject: "Planning sync", startDateTime: "2026-11-25T15:00:00Z", endDateTime: "2026-11-25T15:45:00Z", joinWebUrl: joinUrl,
  participants: { organizer: { upn: "organizer@example.test", identity: { user: { displayName: "Alex Example" } } } },
}
const transcripts = [
  { id: "transcript-prior", meetingId: "meeting-1", createdDateTime: "2026-11-18T15:00:10Z", endDateTime: "2026-11-18T15:40:00Z" },
  { id: "transcript-target", meetingId: "meeting-1", createdDateTime: "2026-11-25T15:00:05Z", endDateTime: "2026-11-25T15:44:00Z" },
]

const calls: { url: URL; accept: string | undefined; authorization: string | undefined }[] = []
const graph = await startFakeHttpServer((request, _body, response) => {
  const url = new URL(request.url ?? "/", "http://example.test")
  calls.push({ url, accept: request.headers.accept, authorization: request.headers.authorization })
  const json = (status: number, payload: object) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload))
  }
  const blocked = (code: string) => json(403, { error: { code: "Forbidden", message: "Blocked by the tenant.", innerError: { code } } })
  const path = url.pathname.replace(/^\/v1\.0/, "")
  if (path === "/me/chats") return json(200, { value: [] })
  if (path === "/me/onlineMeetings" && url.searchParams.get("$filter")?.includes("echo-sentinel")) {
    return json(400, { error: { code: "BadRequest", message: `Invalid filter clause: ${url.searchParams.get("$filter")}` } })
  }
  if (path === "/me/onlineMeetings/meeting-1/transcripts/transcript-long/content") {
    return response.writeHead(200, { "content-type": "text/vtt" }).end(longVtt)
  }
  if (path === "/me/onlineMeetings") {
    return json(200, { value: url.searchParams.get("$filter") === `JoinWebUrl eq '${joinUrl}'` ? [meeting] : [] })
  }
  if (path === "/me/onlineMeetings/meeting-1/transcripts") return json(200, { value: transcripts })
  if (path === "/me/onlineMeetings/meeting-blocked/transcripts") return blocked("GraphAccessToTranscriptsDisabled")
  if (path === "/me/onlineMeetings/meeting-1/transcripts/transcript-target/content") {
    return response.writeHead(200, { "content-type": "text/vtt" }).end(vtt)
  }
  if (path === "/me/onlineMeetings/meeting-1/transcripts/transcript-unnamed/content") {
    if (request.headers.accept === "text/vtt") return blocked("SpeakerAttributionNotAllowed")
    return response.writeHead(200, { "content-type": "application/vnd.microsoft.graph.transcript+text" }).end(plain)
  }
  return json(404, { error: { code: "NotFound", message: "Not found." } })
})
after(() => graph.close())
const den = await bootDen({ env: { DEN_MICROSOFT_GRAPH_BASE_URL: `${graph.url}/v1.0`, DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { upsertConnectedAccount, upsertOrgOAuthClient } = await import("../../src/capability-sources/oauth-credentials.js")
const { getNativeOAuthProvider, resolveProviderScopes } = await import("../../src/capability-sources/provider-registry.js")
const { orgId, owner } = await den.createOrg(await den.signUp("Transcript Reader"), "Teams transcript test")
const api = den.as(owner, orgId)
const key = {
  organizationId: normalizeDenTypeId("organization", orgId),
  orgMembershipId: normalizeDenTypeId("member", owner.memberId),
  providerId: "microsoft-365",
}

async function connect(features: string[], scopes: string[]) {
  await upsertOrgOAuthClient({
    ...key, clientId: "fixture-client", createdByOrgMembershipId: key.orgMembershipId,
    extra: { features, tenantId: "00000000-0000-4000-8000-000000000001" },
  })
  await upsertConnectedAccount({ ...key, accessToken: "fixture-access", tokenType: "Bearer", scopes, expiresAt: new Date(Date.now() + 3_600_000) })
}

const routes = [
  `${base}/teams-meetings?joinUrl=${encodeURIComponent(joinUrl)}`,
  `${base}/teams-meetings/meeting-1/transcripts`,
  `${base}/teams-meetings/meeting-1/transcripts/transcript-target`,
]
const capabilities = ["findMicrosoft365TeamsMeeting", "listMicrosoft365TeamsMeetingTranscripts", "readMicrosoft365TeamsMeetingTranscript"]
  .map((name) => `native:microsoft-365:${name}`)

async function legacyToolList(token: string) {
  const listed = await den.request(token, "POST", "/mcp", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  })
  assert.equal(listed.status, 200, summary(listed))
  assert.match(listed.text, /Microsoft365TeamsChats/)
  return listed.text
}

async function searchNames(token: string) {
  const found = await den.callMcpTool(token, "search_capabilities", { query: "Teams meeting transcript", type: "api", limit: 20 })
  assert.equal(found.status, 200)
  assert.equal(found.isError, false, found.text)
  return list(field(found.structured ?? found.body, "matches")).map((match) => match.name)
}

test("the transcript permission asks Microsoft for both scopes only when it is selected", () => {
  const provider = getNativeOAuthProvider("microsoft-365")
  assert.ok(provider)
  const defaults = resolveProviderScopes(provider, provider.defaultFeatures ?? [])
  assert.equal(defaults.includes(meetingsRead) || defaults.includes(transcriptsRead), false)
  const selected = resolveProviderScopes(provider, ["teamsChatRead", "teamsTranscriptRead"])
  assert.deepEqual(selected.filter((scope) => scope.startsWith("OnlineMeeting")), [meetingsRead, transcriptsRead])
  assert.equal(resolveProviderScopes(provider, ["teamsChatRead", "teamsChatSend"]).some((scope) => scope.startsWith("OnlineMeeting")), false)
})

test("with the feature off, transcript routes answer 404, the tools are hidden and Teams chats still work", async () => {
  await connect(["teamsChatRead", "teamsTranscriptRead"], ["Chat.Read", meetingsRead, transcriptsRead])
  for (const path of routes) {
    const denied = await api("GET", path)
    assert.equal(denied.status, 404, summary(denied))
    assert.deepEqual(denied.body, { error: "feature_disabled", feature: "teamsMeetingTranscripts" })
  }
  assert.equal(calls.length, 0)
  const token = await den.mintMcpToken(owner, orgId)
  const names = await searchNames(token)
  for (const capability of capabilities) assert.equal(names.includes(capability), false, capability)
  const refused = await den.callMcpTool(token, "execute_capability", { name: capabilities[0], query: { joinUrl } })
  assert.equal(refused.isError, true)
  assert.equal(calls.length, 0)
  assert.doesNotMatch(await legacyToolList(token), /TeamsMeeting/)
  const chats = await api("GET", `${base}/teams-chats`)
  assert.equal(chats.status, 200, summary(chats))
  assert.deepEqual(chats.body, { ok: true, chats: [] })
  calls.length = 0
  const enabled = await den.setFeature(orgId, "teamsMeetingTranscripts", true)
  assert.equal(enabled.status, 200, summary(enabled))
})

test("transcript routes refuse callers without sign-in, the permission, or either Microsoft scope, before calling Microsoft", async () => {
  const unsigned = await den.request(null, "GET", routes[0] ?? "", { orgId })
  assert.equal(unsigned.status, 401, summary(unsigned))
  for (const [features, scopes, message] of [
    [["teamsChatRead"], ["Chat.Read", meetingsRead, transcriptsRead], /administrator has disabled Teams meeting transcript read/],
    [["teamsTranscriptRead"], ["Chat.Read", transcriptsRead], /missing the Teams meeting transcript read permission/],
    [["teamsTranscriptRead"], ["Chat.Read", meetingsRead], /missing the Teams meeting transcript read permission/],
  ] as const) {
    await connect([...features], [...scopes])
    for (const path of routes) {
      const refused = await api("GET", path)
      assert.equal(refused.status, 409, summary(refused))
      assert.equal(field(refused.body, "error"), "needs_connection")
      assert.match(String(field(refused.body, "message")), message)
    }
  }
  assert.equal(calls.length, 0)
})

test("a join link must be an https Teams link and ids must not be paths; Microsoft is not called otherwise", async () => {
  await connect(["teamsTranscriptRead"], [meetingsRead, transcriptsRead])
  for (const path of [
    `${base}/teams-meetings`,
    `${base}/teams-meetings?joinUrl=${encodeURIComponent(graph.url)}`,
    `${base}/teams-meetings?joinUrl=${encodeURIComponent("https://teams.microsoft.com.example.test/l/meetup-join/x")}`,
    `${base}/teams-meetings?joinUrl=${encodeURIComponent("http://teams.microsoft.com/l/meetup-join/x")}`,
    `${base}/teams-meetings/${encodeURIComponent("../../me/messages")}/transcripts`,
    `${base}/teams-meetings/meeting-1/transcripts/${encodeURIComponent("a/b")}`,
    `${base}/teams-meetings/meeting-1/transcripts/transcript-target?pageToken=-1`,
    `${base}/teams-meetings/meeting-1/transcripts/transcript-target?maxCharacters=5`,
    `${base}/teams-meetings/meeting-1/transcripts?maxResults=500`,
  ]) {
    const invalid = await api("GET", path)
    assert.equal(invalid.status, 400, `${path}: ${summary(invalid)}`)
  }
  assert.equal(calls.length, 0)
})

test("a member finds the meeting from its join link, lists its transcripts and reads one with speakers and times", async () => {
  await connect(["teamsTranscriptRead"], [meetingsRead, transcriptsRead])
  const found = await api("GET", routes[0] ?? "")
  assert.equal(found.status, 200, summary(found))
  assert.deepEqual(found.body, { ok: true, meeting: {
    id: "meeting-1", subject: "Planning sync", startDateTime: meeting.startDateTime, endDateTime: meeting.endDateTime, joinWebUrl: joinUrl,
    organizer: { name: "Alex Example", address: "organizer@example.test" },
  } })
  const listed = await api("GET", routes[1] ?? "")
  assert.equal(listed.status, 200, summary(listed))
  assert.deepEqual(listed.body, { ok: true, transcripts, nextPageToken: null, hasMore: false })
  const read = await api("GET", routes[2] ?? "")
  assert.equal(read.status, 200, summary(read))
  assert.deepEqual(read.body, { ok: true, transcript: {
    id: "transcript-target", meetingId: "meeting-1", format: "vtt", speakerAttribution: true, content: vtt,
    totalCharacters: vtt.length, nextPageToken: null, contentUnavailableReason: null,
  } })
  assert.deepEqual(calls.map((call) => call.url.pathname), [
    "/v1.0/me/onlineMeetings",
    "/v1.0/me/onlineMeetings/meeting-1/transcripts",
    "/v1.0/me/onlineMeetings/meeting-1/transcripts/transcript-target/content",
  ])
  assert.equal(calls.every((call) => call.authorization === "Bearer fixture-access"), true)
  assert.equal(calls[1]?.url.searchParams.get("$top"), "20")
  assert.equal(calls[2]?.accept, "text/vtt")
  calls.length = 0

  const none = await api("GET", `${base}/teams-meetings?joinUrl=${encodeURIComponent("https://teams.microsoft.com/meet/123456789?p=other")}`)
  assert.deepEqual(none.body, { ok: true, meeting: null })
  const later = await api("GET", `${routes[2]}?maxCharacters=1000&pageToken=8`)
  assert.equal(later.status, 200, summary(later))
  assert.equal(field(later.body, "transcript", "content"), vtt.slice(8))
  assert.equal(field(later.body, "transcript", "nextPageToken"), null)
  assert.equal(field(later.body, "transcript", "totalCharacters"), vtt.length)
  calls.length = 0
})

test("Microsoft tenant settings and errors are reported plainly, without the token or the join link", async () => {
  await connect(["teamsTranscriptRead"], [meetingsRead, transcriptsRead])
  const unnamed = await api("GET", `${base}/teams-meetings/meeting-1/transcripts/transcript-unnamed`)
  assert.equal(unnamed.status, 200, summary(unnamed))
  assert.deepEqual([field(unnamed.body, "transcript", "format"), field(unnamed.body, "transcript", "speakerAttribution"), field(unnamed.body, "transcript", "content")], ["text", false, plain])
  assert.deepEqual(calls.map((call) => call.accept), ["text/vtt", "application/vnd.microsoft.graph.transcript+text"])
  calls.length = 0

  const blocked = await api("GET", `${base}/teams-meetings/meeting-blocked/transcripts`)
  assert.equal(blocked.status, 502, summary(blocked))
  assert.equal(field(blocked.body, "error"), "microsoft_graph_error")
  assert.equal(field(blocked.body, "retryable"), false)
  assert.match(String(field(blocked.body, "message")), /Teams administrator has turned off/)
  assert.equal(calls.length, 1)

  const missing = await api("GET", `${base}/teams-meetings/meeting-unknown/transcripts`)
  assert.equal(missing.status, 502, summary(missing))
  assert.equal(field(missing.body, "error"), "microsoft_graph_error")
  assert.equal(field(missing.body, "retryable"), undefined)
  assert.match(String(field(missing.body, "message")), /404 NotFound\. Microsoft has no such meeting or transcript/)
  const echoed = await api("GET", `${base}/teams-meetings?joinUrl=${encodeURIComponent(`${joinUrl}&p=echo-sentinel`)}`)
  assert.equal(echoed.status, 502, summary(echoed))
  assert.match(String(field(echoed.body, "message")), /400 BadRequest/)
  for (const failure of [blocked, missing, echoed]) {
    assert.equal(failure.text.includes("fixture-access"), false)
    assert.equal(failure.text.includes("meetup-join"), false)
    assert.equal(failure.text.includes("echo-sentinel"), false)
  }
  const stored = await den.auditStorageText()
  for (const action of ["capability.teams.meeting.find", "capability.teams.meeting_transcript.list", "capability.teams.meeting_transcript.read"]) {
    assert.equal(stored.includes(action), true, `${action} missing from audit storage`)
  }
  assert.equal(stored.includes("echo-sentinel"), false, "the join link reached audit storage")
  assert.equal(stored.includes("meetup-join"), false, "the join link reached audit storage")
  assert.equal(stored.includes("We agreed to start"), false, "transcript text reached audit storage")
  calls.length = 0
})

test("with the feature on, agents can find and run the three transcript tools", async () => {
  await connect(["teamsTranscriptRead"], [meetingsRead, transcriptsRead])
  const token = await den.mintMcpToken(owner, orgId)
  const names = await searchNames(token)
  for (const capability of capabilities) assert.equal(names.includes(capability), true, `${capability} missing from ${names.join(", ")}`)
  const found = await den.callMcpTool(token, "execute_capability", { name: capabilities[0], query: { joinUrl } })
  assert.equal(found.isError, false, found.text)
  assert.equal(field(found.body, "meeting", "id"), "meeting-1")
  const read = await den.callMcpTool(token, "execute_capability", {
    name: capabilities[2], path: { meetingId: "meeting-1", transcriptId: "transcript-target" },
  })
  assert.equal(read.isError, false, read.text)
  assert.equal(field(read.body, "transcript", "content"), vtt)
  const listed = await den.callMcpTool(token, "execute_capability", { name: capabilities[1], path: { meetingId: "meeting-1" } })
  assert.equal(listed.isError, false, listed.text)
  assert.deepEqual(list(field(listed.body, "transcripts")).map((transcript) => transcript.id), ["transcript-prior", "transcript-target"])
  assert.match(await legacyToolList(token), /TeamsMeeting/)
})

test("an agent reading a long transcript page by page gets every character, with no page cut by the tool result limit", async () => {
  await connect(["teamsTranscriptRead"], [meetingsRead, transcriptsRead])
  const token = await den.mintMcpToken(owner, orgId)
  assert.ok(longVtt.length > 40_000)
  const pages: string[] = []
  let pageToken: string | undefined
  do {
    const page = await den.callMcpTool(token, "execute_capability", {
      name: capabilities[2], path: { meetingId: "meeting-1", transcriptId: "transcript-long" }, query: { maxCharacters: 18_000, ...(pageToken ? { pageToken } : {}) },
    })
    assert.equal(page.isError, false, page.text)
    const content = String(field(page.body, "transcript", "content"))
    assert.equal(content.includes("[truncated"), false)
    assert.equal(content.endsWith("</v>\n\n") || field(page.body, "transcript", "nextPageToken") === null, true)
    pages.push(content)
    const next = field(page.body, "transcript", "nextPageToken")
    pageToken = typeof next === "string" ? next : undefined
  } while (pageToken && pages.length < 10)
  assert.equal(pages.join(""), longVtt)
  assert.ok(pages.length >= 3)
  const tooLarge = await api("GET", `${base}/teams-meetings/meeting-1/transcripts/transcript-long?maxCharacters=18001`)
  assert.equal(tooLarge.status, 400, summary(tooLarge))
})
