import { isTeamsJoinUrl, type MicrosoftGraphClient, type Microsoft365TeamsTranscript, type Microsoft365TeamsTranscriptContent, type Microsoft365TranscriptEvent } from "./microsoft-graph.js"

export const TRANSCRIPT_EVENT_TOLERANCE_MS = 30 * 60 * 1_000
const MAX_TRANSCRIPT_INTERVAL_MS = 24 * 60 * 60 * 1_000

export function selectEventTranscripts(event: Pick<Microsoft365TranscriptEvent, "start" | "end">, transcripts: readonly Microsoft365TeamsTranscript[]): Microsoft365TeamsTranscript[] {
  const windowStart = Date.parse(event.start) - TRANSCRIPT_EVENT_TOLERANCE_MS
  const windowEnd = Date.parse(event.end) + TRANSCRIPT_EVENT_TOLERANCE_MS
  return transcripts.flatMap((transcript) => {
    const start = Date.parse(transcript.createdDateTime)
    if (!Number.isFinite(start)) return []
    const reportedEnd = Date.parse(transcript.endDateTime)
    const end = reportedEnd >= start && reportedEnd - start <= MAX_TRANSCRIPT_INTERVAL_MS ? reportedEnd : start
    return end >= windowStart && start <= windowEnd ? [{ transcript, start }] : []
  }).sort((a, b) => a.start - b.start).map(({ transcript }) => transcript)
}

export class InvalidEventTranscriptError extends Error {
  constructor() {
    super("The transcriptId does not match a transcript for this calendar event. Use a transcriptId returned for this event.")
    this.name = "InvalidEventTranscriptError"
  }
}

type TranscriptCandidate = Pick<Microsoft365TeamsTranscript, "id" | "createdDateTime" | "endDateTime">
type NoTranscriptReason = "meeting_not_found" | "no_transcript_for_event"
type BaseResult = { ok: true; event: Pick<Microsoft365TranscriptEvent, "id" | "subject" | "start" | "end"> }
type EventTranscriptResult = BaseResult & (
  | { status: "recurring_series" | "not_teams_meeting"; retryable: false; message: string }
  | { status: "no_transcript"; reason: NoTranscriptReason; message: string }
  | { status: "choose_transcript"; candidates: TranscriptCandidate[]; message: string }
  | { status: "transcript"; transcript: TranscriptCandidate & Omit<Microsoft365TeamsTranscriptContent, "offset" | "nextOffset"> & { nextPageToken: string | null } }
)

export async function readMicrosoftEventTranscript(graph: MicrosoftGraphClient, input: {
  eventId: string
  transcriptId?: string
  pageToken?: string
  maxCharacters: number
}): Promise<EventTranscriptResult> {
  const { id, subject, start, end, type, isOnlineMeeting, onlineMeetingProvider, joinUrl } = await graph.getCalendarEventForTranscript(input.eventId)
  const result: BaseResult = { ok: true, event: { id, subject, start, end } }
  if (type === "seriesMaster") {
    return { ...result, status: "recurring_series", retryable: false, message: "This event is a recurring series. Pass the event id of one occurrence from the calendar events list." }
  }
  if (isOnlineMeeting === false || !joinUrl || (onlineMeetingProvider && onlineMeetingProvider !== "teamsForBusiness") || !isTeamsJoinUrl(joinUrl)) {
    return { ...result, status: "not_teams_meeting", retryable: false, message: "This calendar event is not an online Teams meeting." }
  }
  const meetingId = await graph.findTeamsMeetingIdByJoinUrl(joinUrl)
  const noTranscript = (reason: NoTranscriptReason): EventTranscriptResult => ({
    ...result, status: "no_transcript", reason,
    message: "No transcript is available to this member for this calendar event. This does not show whether the meeting was recorded.",
  })
  if (!meetingId) return noTranscript("meeting_not_found")

  const matches = selectEventTranscripts(result.event, await graph.listTeamsMeetingTranscripts(meetingId))
  const { transcriptId } = input
  if (transcriptId === undefined && matches.length > 1) {
    const candidates = matches.map(({ id, createdDateTime, endDateTime }) => ({ id, createdDateTime, endDateTime }))
    return { ...result, status: "choose_transcript", candidates, message: "Several transcripts match this event. Call again with transcriptId for the transcript you want." }
  }
  const selected = transcriptId === undefined ? matches[0] : matches.find((item) => item.id === transcriptId)
  if (transcriptId !== undefined && !selected) throw new InvalidEventTranscriptError()
  if (!selected) return noTranscript("no_transcript_for_event")
  const { offset: _offset, nextOffset, ...page } = await graph.getTeamsMeetingTranscriptContent({
    meetingId, transcriptId: selected.id, offset: Number(input.pageToken ?? 0), maxCharacters: input.maxCharacters,
  })
  const transcript = { id: selected.id, createdDateTime: selected.createdDateTime, endDateTime: selected.endDateTime, ...page, nextPageToken: nextOffset === null ? null : String(nextOffset) }
  return { ...result, status: "transcript", transcript }
}
