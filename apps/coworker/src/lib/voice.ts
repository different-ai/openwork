import type { CoworkerGroupTurn, GroupTimelineEvent } from "./bridge.ts";

export const VOICE_MAX_BYTES = 3 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 60;
export const VOICE_PACKET_CHARS = 450;
export const VOICE_REPLY_CHARS = 2400;
export const VOICE_MAX_PACKETS = 12;

export type VoiceReply = { id: string; turnId: string; text: string };
export type VoiceExpectation = { turnId: string; generation: number; admitted: boolean };

/** Admission can rename only the exact still-owned voice turn, never revive a cancelled one. */
export function rebindVoiceExpectation(current: VoiceExpectation | null, requested: VoiceExpectation | null, acceptedId: string, generation: number): VoiceExpectation | null {
  if (!current || !requested || !acceptedId || current.turnId !== requested.turnId || current.generation !== requested.generation || current.generation !== generation) return null;
  return { ...current, turnId: acceptedId, admitted: true };
}

/** Only pass the existing visible-text projection, never raw engine parts. */
export function privateVoiceReply(messages: readonly {
  id: string; role: string; parentId: string | null; text: string;
  completedAt: number | null; error: unknown; toolCalls: readonly unknown[];
}[], settled: boolean): VoiceReply | null {
  if (!settled) return null;
  const last = messages.findLast((message) => message.role === "assistant");
  if (!last?.parentId || last.completedAt === null || last.error || last.toolCalls.length || !last.text.trim()) return null;
  if (!messages.some((message) => message.id === last.parentId && message.role === "user")) return null;
  return { id: last.id, turnId: last.parentId, text: last.text };
}

export function groupVoiceReply(turn: CoworkerGroupTurn | null, events: readonly GroupTimelineEvent[], nameFor: (slug: string) => string, excludedIds: readonly string[] = []): VoiceReply | null {
  if (!turn || !["succeeded", "partial"].includes(turn.status)) return null;
  if (!events.some((event) => event.kind === "user" && event.turnId === turn.id && event.clientMessageId === turn.clientMessageId)) return null;
  const speakers = turn.speakers.filter((speaker) => speaker.status === "succeeded");
  const replies = speakers.map((speaker) => events.findLast((event) => event.kind === "coworker" && event.turnId === turn.id && event.slug === speaker.slug && event.threadId === speaker.threadId && event.part === speaker.part));
  // Status and timeline are polled independently. Wait for every successful reply.
  if (!replies.length || replies.some((reply) => !reply?.text.trim())) return null;
  const fresh = replies.filter((reply) => reply && !excludedIds.includes(reply.id));
  if (!fresh.length) return null;
  return { id: `${turn.id}:${fresh.map((reply) => reply?.id).join(":")}`, turnId: turn.clientMessageId, text: fresh.map((reply) => reply ? `${nameFor(reply.slug ?? "")}: ${reply.text}` : "").join("\n\n") };
}

export function voicePackets(text: string): { packets: string[]; truncated: boolean } {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[\s#>*-]+/gm, "").replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ").trim();
  const packets: string[] = [];
  let remaining = VOICE_REPLY_CHARS;
  let truncated = false;
  sentences: for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(prose)) {
    let sentence = segment.trim();
    while (sentence) {
      if (remaining <= 0 || packets.length === VOICE_MAX_PACKETS) { truncated = true; break sentences; }
      const limit = Math.min(VOICE_PACKET_CHARS, remaining);
      let end = Math.min(sentence.length, limit);
      if (end < sentence.length) {
        const space = sentence.lastIndexOf(" ", end);
        if (space > 0) end = space;
        // Do not split an astral character when a long unbroken word hits the cap.
        if (/[\uD800-\uDBFF]/.test(sentence.charAt(end - 1))) end -= 1;
      }
      if (!end) { truncated = true; break sentences; }
      packets.push(sentence.slice(0, end).trim());
      remaining -= end;
      sentence = sentence.slice(end).trim();
    }
  }
  return { packets, truncated };
}

export function recordingType(supported: (mime: string) => boolean): { mimeType: string; format: "webm" | "m4a" } | null {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"]) {
    if (supported(mimeType)) return { mimeType, format: mimeType.startsWith("audio/mp4") ? "m4a" : "webm" };
  }
  return null;
}

export function appendVoiceDraft(draft: string, transcript: string): string {
  const words = transcript.trim();
  return words ? `${draft}${draft && !/\s$/.test(draft) ? "\n" : ""}${words}` : draft;
}

export function voiceError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/voice_membership_required/.test(message)) return "Voice needs an active OpenWork Models membership. Your text conversation is unchanged.";
  if (/voice_(?:sign_in|unauthorized)/.test(message)) return "Sign in again to use voice. Your draft is kept.";
  if (/voice_quota_exhausted/.test(message)) return "Your OpenWork Models voice allowance is used up. Check your membership usage or keep typing; your draft is kept.";
  if (/voice_(?:request_)?cancelled/.test(message)) return "Voice cancelled. Your draft is kept.";
  if (/voice_timeout/.test(message)) return "Voice took too long. Try a shorter recording, or keep typing.";
  if (/NotAllowedError|voice_microphone/.test(message)) return "Microphone access was not granted. Allow it in system settings, then try again.";
  if (/NotFoundError/.test(message)) return "No microphone was found. Connect one, or keep typing.";
  return "Voice is unavailable right now. Your draft and text conversation are kept; try again when ready.";
}
