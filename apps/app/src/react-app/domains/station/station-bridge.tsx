/** @jsxImportSource react */
import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  tool,
} from "@openai/agents/realtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { openDesktopUrl } from "@/app/lib/desktop";
import type {
  OpenworkServerClient,
  OpenworkSessionMessage,
  OpenworkStationSuggestion,
} from "@/app/lib/openwork-server";
import { recordInspectorEvent, publishInspectorSlice } from "@/app/lib/app-inspector";
import { useControlAction, type OpenworkControlAction } from "@/react-app/shell/control/control-provider";
import { rankStationSuggestions } from "./station-relevance";
import {
  INITIAL_STATION_STATE,
  isStationCommand,
  type StationCommand,
  type StationState,
} from "./station-types";

type OpenWorkStationBridgeProps = {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  sessionId: string | null;
};

const realtime = {
  session: null as RealtimeSession | null,
  stream: null as MediaStream | null,
  audioContext: null as AudioContext | null,
  analyser: null as AnalyserNode | null,
  energyFrame: null as number | null,
  partialByItem: new Map<string, string>(),
  completedByItem: new Map<string, string>(),
  sequenceByItem: new Map<string, number>(),
  nextSequence: 0,
  baseTranscript: "",
};

const DEMO_NOW = Date.now();
const DEMO_SUGGESTIONS: OpenworkStationSuggestion[] = [
  {
    id: "station-demo-memory",
    kind: "memory",
    title: "Maya’s launch concern from last week",
    summary: "Maya said the enterprise pilot must keep customer transcripts out of durable project history before her team can join the launch.",
    reason: "Maya is in today’s meeting and the question refers directly to what she told you last week.",
    relevance: 0.97,
    color: "#8B7CFF",
    sources: [{
      label: "Maya · #enterprise-launch · last Tuesday",
      provider: "Slack",
      url: "https://app.slack.com/client/openwork/enterprise-launch",
    }],
    action: {
      kind: "open_source",
      label: "Open Slack message",
      url: "https://app.slack.com/client/openwork/enterprise-launch",
    },
    createdAt: DEMO_NOW,
  },
  {
    id: "station-demo-calendar",
    kind: "calendar",
    title: "Berlin ↔ Denver working session",
    summary: "2:00 PM in Denver is 10:00 PM in Berlin. Station prepared a 30-minute invitation with both local times visible.",
    reason: "The conversation moved from availability to a concrete cross-time-zone meeting.",
    relevance: 0.86,
    color: "#38C6A5",
    sources: [{
      label: "Today’s meeting attendees",
      provider: "Google Calendar",
      url: "https://calendar.google.com/calendar/u/0/r",
    }],
    action: {
      kind: "review_draft",
      label: "Review calendar draft",
      draft: "Berlin ↔ Denver working session\n\nTime: 2:00–2:30 PM Denver / 10:00–10:30 PM Berlin\nAttendees: Maya, Jalil\nNotes: Review the enterprise pilot privacy requirement before launch.",
    },
    createdAt: DEMO_NOW + 1,
  },
  {
    id: "station-demo-follow-up",
    kind: "follow_up",
    title: "Follow up with Maya",
    summary: "A concise follow-up is ready with the privacy decision and the next review point from this call.",
    reason: "You committed to contact Maya immediately after the conversation.",
    relevance: 0.76,
    color: "#FF8D5C",
    sources: [{
      label: "Maya · meeting participant",
      provider: "Google Calendar",
      url: "https://calendar.google.com/calendar/u/0/r",
    }],
    action: {
      kind: "review_draft",
      label: "Review email draft",
      draft: "Subject: Enterprise pilot privacy follow-up\n\nHi Maya,\n\nFollowing up on today’s call: we’re treating transcript retention as a launch requirement, and I’ll share the reviewed boundary before the next pilot session.\n\nBest,\nJalil",
    },
    createdAt: DEMO_NOW + 2,
  },
  {
    id: "station-demo-decision",
    kind: "context",
    title: "Privacy boundary is becoming a decision",
    summary: "The group is converging on an explicit rule: live conversation context can help in the moment without becoming durable project history.",
    reason: "The discussion has moved from recalling a concern to defining the operating boundary.",
    relevance: 0.68,
    color: "#4EA8FF",
    sources: [{
      label: "Enterprise pilot · privacy decision thread",
      provider: "Slack",
      url: "https://app.slack.com/client/openwork/enterprise-launch",
    }],
    action: {
      kind: "open_source",
      label: "Open decision thread",
      url: "https://app.slack.com/client/openwork/enterprise-launch",
    },
    createdAt: DEMO_NOW + 3,
  },
  {
    id: "station-demo-dependency",
    kind: "memory",
    title: "Sam is waiting on this answer",
    summary: "Sam’s rollout checklist is blocked until the transcript-retention boundary is confirmed for the pilot.",
    reason: "Today’s decision changes a dependency owned by someone who is not in the current conversation.",
    relevance: 0.57,
    color: "#C66FF2",
    sources: [{
      label: "Sam · #pilot-ops · rollout checklist",
      provider: "Slack",
      url: "https://app.slack.com/client/openwork/pilot-ops",
    }],
    action: {
      kind: "open_source",
      label: "Open rollout context",
      url: "https://app.slack.com/client/openwork/pilot-ops",
    },
    createdAt: DEMO_NOW + 4,
  },
  {
    id: "station-demo-checkpoint",
    kind: "calendar",
    title: "Friday privacy checkpoint",
    summary: "The existing Friday pilot review is the natural place to confirm the retention boundary before the next customer session.",
    reason: "A nearby calendar moment can absorb the decision without creating another meeting.",
    relevance: 0.48,
    color: "#E7B957",
    sources: [{
      label: "Friday · Enterprise pilot review",
      provider: "Google Calendar",
      url: "https://calendar.google.com/calendar/u/0/r",
    }],
    action: {
      kind: "review_draft",
      label: "Review agenda note",
      draft: "Enterprise pilot review\n\nAdd to agenda: confirm the transcript-retention boundary and unblock Sam’s rollout checklist.",
    },
    createdAt: DEMO_NOW + 5,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function meaningfulTranscript(value: string) {
  return /[\p{Letter}\p{Number}]/u.test(value);
}

function sessionMessageText(message: OpenworkSessionMessage) {
  return message.parts.flatMap((part) => {
    if (part.type !== "text" || part.synthetic || part.ignored) return [];
    const text = part.text.trim();
    return text ? [text] : [];
  }).join("\n").trim();
}

async function loadSessionContext(
  client: OpenworkServerClient,
  workspaceId: string | null,
  sessionId: string | null,
) {
  if (!workspaceId || !sessionId) return "";
  try {
    const response = await client.getSessionMessages(workspaceId, sessionId, { limit: 16 });
    return response.items.flatMap((message) => {
      const role = message.info.role;
      if (role !== "user" && role !== "assistant") return [];
      const text = sessionMessageText(message);
      return text ? [`${role === "user" ? "User" : "Assistant"}: ${text}`] : [];
    }).slice(-8).join("\n\n").slice(-4_000);
  } catch {
    return "";
  }
}

async function requestMicrophonePermission() {
  const ask = window.__OPENWORK_ELECTRON__?.system?.askMicrophoneAccess;
  if (!ask) return true;
  const result = await ask();
  return result.platform !== "darwin" || result.granted;
}

function disconnectRealtime() {
  if (realtime.energyFrame !== null) window.cancelAnimationFrame(realtime.energyFrame);
  try { realtime.session?.close(); } catch {}
  try { realtime.stream?.getTracks().forEach((track) => track.stop()); } catch {}
  try { void realtime.audioContext?.close(); } catch {}
  realtime.session = null;
  realtime.stream = null;
  realtime.audioContext = null;
  realtime.analyser = null;
  realtime.energyFrame = null;
  realtime.partialByItem.clear();
  realtime.completedByItem.clear();
  realtime.sequenceByItem.clear();
  realtime.nextSequence = 0;
  realtime.baseTranscript = "";
}

function stageDemoSuggestions(stage: string) {
  if (stage === "memory") return DEMO_SUGGESTIONS.slice(0, 1);
  if (stage === "calendar") return DEMO_SUGGESTIONS.slice(0, 2);
  if (stage === "follow_up" || stage === "living") return DEMO_SUGGESTIONS;
  if (stage === "stopped") return DEMO_SUGGESTIONS;
  return [];
}

export function OpenWorkStationBridge(props: OpenWorkStationBridgeProps) {
  const [state, setState] = useState<StationState>(INITIAL_STATION_STATE);
  const stateRef = useRef(state);
  const analysisInFlightRef = useRef(false);
  const pendingAnalysisRef = useRef<string | null>(null);
  const transcriptRef = useRef("");
  stateRef.current = state;

  const publish = useCallback((next: StationState) => {
    stateRef.current = next;
    setState(next);
    window.__OPENWORK_ELECTRON__?.station?.publishState?.(next);
  }, []);

  const updateState = useCallback((updater: (current: StationState) => StationState) => {
    publish(updater(stateRef.current));
  }, [publish]);

  const analyzeTranscript = useCallback(async (transcript: string) => {
    if (!props.client || !props.workspaceId || !transcript.trim()) return;
    if (analysisInFlightRef.current) {
      pendingAnalysisRef.current = transcript;
      return;
    }
    analysisInFlightRef.current = true;
    updateState((current) => ({
      ...current,
      status: current.listening ? "analyzing" : current.status,
      statusText: "Passive agent researching through OpenWork Connect…",
      error: null,
    }));
    try {
      const sessionContext = await loadSessionContext(props.client, props.workspaceId, props.sessionId);
      const response = await props.client.getStationSuggestions(props.workspaceId, {
        transcript,
        ...(sessionContext ? { sessionContext } : {}),
      });
      updateState((current) => {
        const suggestions = rankStationSuggestions(current.suggestions, response.suggestions, transcript);
        return {
          ...current,
          status: current.listening ? "listening" : "idle",
          statusText: response.source === "openwork-connect"
            ? "Listening · connected context ready"
            : "Listening · local signals only",
          suggestions,
          selectedId: suggestions.some((suggestion) => suggestion.id === current.selectedId)
            ? current.selectedId
            : suggestions[0]?.id ?? null,
          source: response.source,
          error: null,
        };
      });
      recordInspectorEvent("station.analysis.completed", {
        workspaceId: props.workspaceId,
        source: response.source,
        suggestionCount: response.suggestions.length,
      });
    } catch (error) {
      updateState((current) => ({
        ...current,
        status: current.listening ? "listening" : "error",
        statusText: "Listening · connected research needs attention",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      analysisInFlightRef.current = false;
      const pending = pendingAnalysisRef.current;
      pendingAnalysisRef.current = null;
      if (pending && pending !== transcript) void analyzeTranscript(pending);
    }
  }, [props.client, props.sessionId, props.workspaceId, updateState]);

  const scanScenario = useCallback(async (args: unknown) => {
    const transcript = isRecord(args) && typeof args.transcript === "string"
      ? args.transcript.trim().slice(-12_000)
      : "";
    if (!transcript) return { ok: false, error: "A scenario transcript is required." };
    if (!props.client || !props.workspaceId) {
      return { ok: false, error: "A connected OpenWork workspace is required." };
    }
    transcriptRef.current = transcript;
    publish({
      ...stateRef.current,
      status: "analyzing",
      statusText: "Scanning the conversation through OpenWork Connect…",
      visible: true,
      transcript,
      partialTranscript: "",
      suggestions: [],
      selectedId: null,
      source: null,
      error: null,
    });
    await window.__OPENWORK_ELECTRON__?.station?.show?.();
    await window.__OPENWORK_ELECTRON__?.station?.setExpanded?.(false);
    await analyzeTranscript(transcript);
    return {
      ok: stateRef.current.error === null,
      source: stateRef.current.source,
      suggestions: stateRef.current.suggestions,
      error: stateRef.current.error,
    };
  }, [analyzeTranscript, props.client, props.workspaceId, publish]);

  const completeTranscript = useCallback((itemId: string, transcript: string) => {
    const clean = transcript.trim();
    if (!meaningfulTranscript(clean)) return;
    if (!realtime.sequenceByItem.has(itemId)) {
      realtime.sequenceByItem.set(itemId, realtime.nextSequence++);
    }
    realtime.completedByItem.set(itemId, clean);
    const orderedLiveTranscript = Array.from(realtime.completedByItem.entries())
      .sort(([left], [right]) => (
        (realtime.sequenceByItem.get(left) ?? 0) - (realtime.sequenceByItem.get(right) ?? 0)
      ))
      .map(([, value]) => value)
      .join("\n");
    const combined = `${realtime.baseTranscript}\n${orderedLiveTranscript}`.trim().slice(-12_000);
    transcriptRef.current = combined;
    updateState((current) => ({
      ...current,
      transcript: combined,
      partialTranscript: "",
      statusText: "Listening · understanding what matters",
    }));
    recordInspectorEvent("station.transcript.completed", {
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      length: clean.length,
    });
  }, [props.sessionId, props.workspaceId, updateState]);

  const handleRealtimeEvent = useCallback((event: unknown) => {
    const type = readString(event, "type");
    if (type === "conversation.item.created") {
      const item = isRecord(event) && isRecord(event.item) ? event.item : {};
      const itemId = readString(item, "id");
      if (itemId && !realtime.sequenceByItem.has(itemId)) {
        realtime.sequenceByItem.set(itemId, realtime.nextSequence++);
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = readString(event, "item_id") || "active";
      if (!realtime.sequenceByItem.has(itemId)) {
        realtime.sequenceByItem.set(itemId, realtime.nextSequence++);
      }
      const delta = readString(event, "delta");
      const partial = `${realtime.partialByItem.get(itemId) ?? ""}${delta}`;
      realtime.partialByItem.set(itemId, partial);
      updateState((current) => ({
        ...current,
        partialTranscript: partial,
        status: "listening",
        statusText: "Listening · live transcription",
      }));
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = readString(event, "item_id") || "active";
      const transcript = readString(event, "transcript") || realtime.partialByItem.get(itemId) || "";
      realtime.partialByItem.delete(itemId);
      completeTranscript(itemId, transcript);
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      updateState((current) => ({ ...current, status: "listening", statusText: "Listening · hearing you" }));
      return;
    }
    if (type === "error") {
      const error = isRecord(event) && isRecord(event.error) ? readString(event.error, "message") : "";
      updateState((current) => ({
        ...current,
        status: "error",
        statusText: "Realtime transcription needs attention",
        error: error || "OpenAI Realtime reported an error.",
      }));
    }
  }, [completeTranscript, updateState]);

  const stop = useCallback(async () => {
    disconnectRealtime();
    updateState((current) => ({
      ...current,
      status: "idle",
      statusText: "Listening stopped · your context remains ready",
      listening: false,
      partialTranscript: "",
      audioEnergy: 0,
      error: null,
      visible: true,
    }));
    recordInspectorEvent("station.stopped", { workspaceId: props.workspaceId });
    return { ok: true };
  }, [props.workspaceId, updateState]);

  const monitorAudioEnergy = useCallback(async (stream: MediaStream) => {
    const AudioContextClass = window.AudioContext
      ?? Reflect.get(window, "webkitAudioContext") as typeof AudioContext | undefined;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    context.createMediaStreamSource(stream).connect(analyser);
    await context.resume().catch(() => undefined);
    realtime.audioContext = context;
    realtime.analyser = analyser;
    const samples = new Uint8Array(analyser.fftSize);
    let smoothed = 0;
    let lastPublished = 0;
    const readEnergy = (now: number) => {
      if (realtime.analyser !== analyser) return;
      analyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      const target = Math.min(1, Math.max(0, (rms - 0.012) * 9));
      smoothed = smoothed * 0.72 + target * 0.28;
      if (now - lastPublished >= 80) {
        lastPublished = now;
        const audioEnergy = Number(smoothed.toFixed(3));
        updateState((current) => (
          Math.abs(current.audioEnergy - audioEnergy) < 0.025
            ? current
            : { ...current, audioEnergy }
        ));
      }
      realtime.energyFrame = window.requestAnimationFrame(readEnergy);
    };
    realtime.energyFrame = window.requestAnimationFrame(readEnergy);
  }, [updateState]);

  const start = useCallback(async () => {
    if (stateRef.current.listening) return { ok: true, alreadyListening: true };
    if (!props.client || !props.workspaceId) {
      updateState((current) => ({
        ...current,
        visible: true,
        status: "error",
        statusText: "OpenWork Station needs a connected workspace",
        error: "Connect a workspace before starting Station.",
      }));
      return { ok: false, error: "OpenWork Station needs a connected workspace." };
    }
    await window.__OPENWORK_ELECTRON__?.station?.show?.();
    updateState((current) => ({
      ...current,
      visible: true,
      status: "connecting",
      statusText: "Starting your passive AI right hand…",
      error: null,
    }));
    try {
      if (!(await requestMicrophonePermission())) {
        throw new Error("Microphone access was not granted.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      await monitorAudioEnergy(stream);
      const sessionContext = await loadSessionContext(props.client, props.workspaceId, props.sessionId);
      const credentials = await props.client.createStationRealtimeSession({
        ...(sessionContext ? { sessionContext } : {}),
      });
      const researchCurrentContext = tool({
        name: "research_current_context",
        description: [
          "Research the latest meaningful work conversation through OpenWork's review-only contextual scanner.",
          "Use this when a person, past discussion, commitment, date, decision, or useful next step may benefit from connected context.",
          "The tool only prepares cited suggestions and reviewable drafts; it cannot send, schedule, create, update, or delete anything.",
        ].join(" "),
        parameters: z.object({
          transcript: z.string()
            .min(1)
            .max(12_000)
            .describe("The meaningful spoken turn or conversation context that should be researched."),
        }),
        execute: async ({ transcript }) => {
          const latestTranscript = (transcriptRef.current.trim() || transcript.trim()).slice(-12_000);
          if (!latestTranscript) {
            return JSON.stringify({ ok: false, reason: "No meaningful transcript is available yet." });
          }
          await analyzeTranscript(latestTranscript);
          return JSON.stringify({
            ok: stateRef.current.error === null,
            source: stateRef.current.source,
            suggestions: stateRef.current.suggestions.slice(0, 3).map((suggestion) => ({
              kind: suggestion.kind,
              title: suggestion.title,
              summary: suggestion.summary,
              reason: suggestion.reason,
              sources: suggestion.sources.map((source) => ({
                label: source.label,
                provider: source.provider,
                url: source.url,
              })),
              action: suggestion.action.kind,
            })),
          });
        },
      });
      const agent = new RealtimeAgent({
        name: "OpenWork Station",
        instructions: [
          "You are OpenWork Station, a silent passive AI right hand beside a live work conversation.",
          "Listen continuously but never speak or address the people in the room. Your text output is internal and is not presented as a chat reply.",
          "After each meaningful work-related turn, decide whether connected context could genuinely help. If it could, call research_current_context once with the relevant spoken context.",
          "Use the tool for references to people, earlier conversations, decisions, dates, commitments, follow-ups, or concrete next steps. Ignore filler, background noise, repetitions, and casual speech.",
          "The tool is review-only. Never send a message, schedule an event, create or update a record, or imply that an external action happened.",
          sessionContext ? `Current OpenWork session context:\n${sessionContext}` : "",
        ].filter(Boolean).join("\n\n"),
        tools: [researchCurrentContext],
      });
      const transport = new OpenAIRealtimeWebRTC({ mediaStream: stream });
      const sdkSession = new RealtimeSession(agent, {
        model: credentials.model,
        transport,
        config: {
          outputModalities: ["text"],
          toolChoice: "auto",
          audio: {
            input: {
              transcription: {
                model: credentials.transcriptionModel,
                language: "en",
                prompt: "OpenWork Station ambient work conversation. Preserve names, companies, dates, times, and commitments accurately.",
              },
              noiseReduction: { type: "near_field" },
              turnDetection: {
                type: "server_vad",
                threshold: 0.5,
                silenceDurationMs: 550,
                prefixPaddingMs: 300,
                createResponse: true,
                interruptResponse: false,
              },
            },
          },
          reasoning: { effort: "low" },
        },
        tracingDisabled: true,
      });
      realtime.stream = stream;
      realtime.session = sdkSession;
      realtime.baseTranscript = transcriptRef.current;
      realtime.partialByItem.clear();
      realtime.completedByItem.clear();
      realtime.sequenceByItem.clear();
      realtime.nextSequence = 0;
      sdkSession.on("transport_event", (event) => {
        handleRealtimeEvent(event);
      });
      sdkSession.on("agent_tool_start", () => {
        updateState((current) => ({
          ...current,
          status: current.listening ? "analyzing" : current.status,
          statusText: "Passive agent found a useful thread · researching…",
          error: null,
        }));
      });
      sdkSession.on("agent_tool_end", () => {
        updateState((current) => ({
          ...current,
          status: current.listening ? "listening" : current.status,
          statusText: current.source === "openwork-connect"
            ? "Listening · connected context ready"
            : "Listening · understanding what matters",
        }));
      });
      sdkSession.on("error", (event) => {
        const detail = isRecord(event) ? event.error : event;
        const message = isRecord(detail) ? readString(detail, "message") : "";
        updateState((current) => ({
          ...current,
          status: "error",
          statusText: "Realtime agent needs attention",
          error: message || "OpenAI Realtime reported an error.",
        }));
      });
      await sdkSession.connect({
        apiKey: credentials.clientSecret,
        model: credentials.model,
      });
      updateState((current) => ({
        ...current,
        visible: true,
        status: "listening",
        statusText: "Listening · your passive AI right hand is active",
        listening: true,
        audioEnergy: 0,
        error: null,
      }));
      recordInspectorEvent("station.started", {
        workspaceId: props.workspaceId,
        model: credentials.model,
        transcriptionModel: credentials.transcriptionModel,
        sdk: "@openai/agents",
      });
      return {
        ok: true,
        model: credentials.model,
        transcriptionModel: credentials.transcriptionModel,
      };
    } catch (error) {
      disconnectRealtime();
      const message = error instanceof Error ? error.message : String(error);
      updateState((current) => ({
        ...current,
        visible: true,
        listening: false,
        audioEnergy: 0,
        status: "error",
        statusText: "Station could not start listening",
        error: message,
      }));
      return { ok: false, error: message };
    }
  }, [
    analyzeTranscript,
    handleRealtimeEvent,
    monitorAudioEnergy,
    props.client,
    props.sessionId,
    props.workspaceId,
    updateState,
  ]);

  const activateSuggestion = useCallback(async (id: string | undefined) => {
    const suggestion = stateRef.current.suggestions.find((item) => item.id === id)
      ?? stateRef.current.suggestions.find((item) => item.id === stateRef.current.selectedId);
    if (!suggestion) return { ok: false, error: "Suggestion not found." };
    if (suggestion.action.kind === "open_source") {
      const url = suggestion.action.url || suggestion.sources[0]?.url;
      if (!url) return { ok: false, error: "This suggestion has no source link." };
      await openDesktopUrl(url);
      return { ok: true, action: "open_source" };
    }
    if (suggestion.action.kind === "review_draft" && suggestion.action.draft) {
      const control = window.__openworkControl;
      if (!control) return { ok: false, error: "OpenWork review surface is unavailable." };
      const result = await control.execute("composer.set_text", { text: suggestion.action.draft });
      updateState((current) => ({
        ...current,
        statusText: "Draft opened in OpenWork for your review",
      }));
      return result;
    }
    return { ok: true, action: "none" };
  }, [updateState]);

  const seedDemo = useCallback(async (args: unknown) => {
    const stage = isRecord(args) && typeof args.stage === "string" ? args.stage : "living";
    const demoNow = Date.now();
    const rawSuggestions = stageDemoSuggestions(stage).map((suggestion, index) => ({
      ...suggestion,
      createdAt: demoNow + index,
    }));
    const suggestions = rankStationSuggestions(
      [],
      rawSuggestions,
      "Maya remember last week Denver Berlin follow up privacy Sam Friday",
      demoNow + rawSuggestions.length,
    );
    const selectedId = stage === "calendar"
      ? "station-demo-calendar"
      : stage === "follow_up"
        ? "station-demo-follow-up"
        : suggestions[0]?.id ?? null;
    const listening = stage !== "stopped";
    transcriptRef.current = stage === "wake"
      ? ""
      : stage === "listening"
      ? "Maya, do you remember what I told you last week?"
      : "Maya asked about last week’s launch concern. We discussed meeting at 2 PM Denver time, and I promised to follow up after the call.";
    publish({
      status: listening ? "listening" : "idle",
      statusText: listening
        ? rawSuggestions.length ? "Listening · connected context ready" : "Listening · understanding what matters"
        : "Listening stopped · your context remains ready",
      listening,
      visible: true,
      transcript: transcriptRef.current,
      partialTranscript: "",
      audioEnergy: listening ? 0.24 : 0,
      suggestions,
      selectedId,
      source: "demo",
      error: null,
    });
    await window.__OPENWORK_ELECTRON__?.station?.show?.();
    await window.__OPENWORK_ELECTRON__?.station?.setExpanded?.(false);
    return { ok: true, stage, suggestionCount: suggestions.length };
  }, [publish]);

  const handleCommand = useCallback(async (command: StationCommand) => {
    if (command.type === "start") return start();
    if (command.type === "stop") return stop();
    if (command.type === "toggle-listening") return stateRef.current.listening ? stop() : start();
    if (command.type === "activate") return activateSuggestion(command.id);
    if (command.type === "dismiss") {
      updateState((current) => {
        const suggestions = current.suggestions.filter((suggestion) => suggestion.id !== command.id);
        return {
          ...current,
          suggestions,
          selectedId: suggestions[0]?.id ?? null,
        };
      });
      return { ok: true };
    }
    if (command.type === "select") {
      updateState((current) => ({
        ...current,
        selectedId: current.suggestions.some((suggestion) => suggestion.id === command.id)
          ? command.id ?? null
          : current.selectedId,
      }));
      return { ok: true };
    }
    if (command.type === "seed-demo") return seedDemo({ stage: "living" });
    if (command.type === "hide") {
      await window.__OPENWORK_ELECTRON__?.station?.hide?.();
      updateState((current) => ({ ...current, visible: false }));
      return { ok: true };
    }
    return { ok: false, error: "Unsupported Station command." };
  }, [activateSuggestion, seedDemo, start, stop, updateState]);

  useEffect(() => {
    const onCommand = window.__OPENWORK_ELECTRON__?.station?.onCommand;
    if (!onCommand) return undefined;
    return onCommand((value) => {
      if (isStationCommand(value)) void handleCommand(value);
    });
  }, [handleCommand]);

  useEffect(() => {
    window.__OPENWORK_ELECTRON__?.station?.publishState?.(stateRef.current);
  }, []);

  useEffect(() => () => {
    disconnectRealtime();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      updateState((current) => {
        if (!current.suggestions.length) return current;
        const suggestions = rankStationSuggestions(current.suggestions, [], current.transcript);
        if (suggestions.every((item, index) => item.id === current.suggestions[index]?.id
          && item.effectiveRelevance === current.suggestions[index]?.effectiveRelevance)) {
          return current;
        }
        return {
          ...current,
          suggestions,
          selectedId: suggestions.some((suggestion) => suggestion.id === current.selectedId)
            ? current.selectedId
            : suggestions[0]?.id ?? null,
        };
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [updateState]);

  useEffect(() => publishInspectorSlice("station", () => state), [state]);

  const showAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.show",
    label: "Show OpenWork Station",
    description: "Show the native OpenWork Station edge surface.",
    sideEffect: "none",
    execute: async () => {
      await window.__OPENWORK_ELECTRON__?.station?.show?.();
      updateState((current) => ({ ...current, visible: true }));
      return { visible: true };
    },
  }), [updateState]);
  useControlAction(showAction);

  const startAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.start",
    label: "Start OpenWork Station",
    description: "Start consent-gated live transcription and the passive agent loop.",
    sideEffect: "external",
    disabled: !props.client || state.listening,
    execute: start,
  }), [props.client, start, state.listening]);
  useControlAction(startAction);

  const stopAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.stop",
    label: "Stop OpenWork Station",
    description: "Stop transcription immediately while preserving reviewable suggestions.",
    sideEffect: "external",
    disabled: !state.listening,
    execute: stop,
  }), [state.listening, stop]);
  useControlAction(stopAction);

  const seedAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.seed_demo",
    label: "Load the Station interaction scenario",
    description: "Deterministic interaction hook for exercising the passive Station surface.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [{ name: "stage", type: "string", required: true, description: "listening, memory, living, calendar, follow_up, or stopped" }],
    previewArgs: { stage: "living" },
    execute: seedDemo,
  }), [seedDemo]);
  useControlAction(seedAction);

  const scenarioAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.scan_scenario",
    label: "Scan a conversation with OpenWork Station",
    description: "Run a realistic transcript through the live passive-agent and Connect analysis path.",
    sideEffect: "external",
    requiresArgs: true,
    args: [{
      name: "transcript",
      type: "string",
      required: true,
      description: "Recent conversation text to scan as if it had just been transcribed.",
    }],
    previewArgs: {
      transcript: "Do you remember what I told you last week? Let’s meet next Tuesday, and I’ll follow up after this call.",
    },
    execute: scanScenario,
  }), [scanScenario]);
  useControlAction(scenarioAction);

  const selectAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.select",
    label: "Select a Station suggestion",
    description: "Select a relevance bubble by id.",
    sideEffect: "none",
    requiresArgs: true,
    args: [{ name: "id", type: "string", required: true, description: "Suggestion id." }],
    execute: (args) => handleCommand({
      type: "select",
      id: isRecord(args) && typeof args.id === "string" ? args.id : undefined,
    }),
  }), [handleCommand]);
  useControlAction(selectAction);

  const activateAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.activate",
    label: "Open a Station suggestion for review",
    description: "Open a cited source or put a prepared draft into the OpenWork review surface.",
    sideEffect: "none",
    requiresArgs: true,
    args: [{ name: "id", type: "string", required: true, description: "Suggestion id." }],
    execute: (args) => activateSuggestion(
      isRecord(args) && typeof args.id === "string" ? args.id : undefined,
    ),
  }), [activateSuggestion]);
  useControlAction(activateAction);

  const statusAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.status",
    label: "Read OpenWork Station status",
    description: "Return the passive Station runtime state.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => stateRef.current,
  }), []);
  useControlAction(statusAction);

  return null;
}
