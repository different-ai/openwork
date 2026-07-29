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
import { stationDismissal, stationHistorySelection } from "./station-history";
import { stationGoalVoiceDecision } from "./station-goal";
import { buildStationThreadHandoff, type StationThreadHandoff } from "./station-handoff";
import { createLiveConversationSuggestion } from "./station-live-suggestion";
import { rankStationSuggestions } from "./station-relevance";
import {
  INITIAL_STATION_STATE,
  isStationCommand,
  type StationCommand,
  type StationGoal,
  type StationScenarioRuntime,
  type StationState,
} from "./station-types";
import {
  OPENWORK_STATION_REALTIME_MODEL,
  lifecycleObservation,
  stationPresentationText,
  transitionStationRuntime,
  type StationInputSource,
  type StationLifecycleEventName,
  type StationRuntimeEvent,
} from "./station-runtime";
import {
  evaluateStationScenario,
  scheduledStationScenarioSteps,
  stationScenarioById,
  stationScenarioDuration,
  type StationScenario,
  type StationScenarioStep,
} from "./station-scenarios";
import { StationTranscriptAccumulator } from "./station-transcript";

type OpenWorkStationBridgeProps = {
  enabled: boolean;
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  sessionId: string | null;
  onCreateThread: (handoff: StationThreadHandoff) => Promise<string | null>;
};

type FixturePlayback = {
  stream: MediaStream;
  play: (url: string) => Promise<void>;
  close: () => void;
};

type StationStartOptions = {
  mediaStream?: MediaStream;
  inputSource?: Extract<StationInputSource, "microphone" | "fixture">;
};

const realtime = {
  session: null as RealtimeSession | null,
  stream: null as MediaStream | null,
  audioContext: null as AudioContext | null,
  analyser: null as AnalyserNode | null,
  energyFrame: null as number | null,
  transcript: new StationTranscriptAccumulator(),
  requestedToolCalls: new Set<string>(),
  scoutTimer: null as number | null,
  scoutInFlight: false,
  responseInFlight: false,
  lastScoutText: "",
  lastScoutCharacterCount: 0,
  lastScoutAt: 0,
  pendingScoutText: "",
  pendingScoutCharacterCount: 0,
  handledGoals: [] as string[],
  fixturePlayback: null as FixturePlayback | null,
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

function publicStatusForRuntime(runtime: StationState["runtime"]): StationState["status"] {
  if (runtime.presentation === "starting") return "connecting";
  if (runtime.presentation === "researching" || runtime.presentation === "understanding") return "analyzing";
  if (runtime.presentation === "needs_attention") return "error";
  if (
    runtime.presentation === "listening"
    || runtime.presentation === "context_ready"
    || runtime.presentation === "nothing_useful"
  ) return "listening";
  return "idle";
}

async function createFixturePlayback(): Promise<FixturePlayback> {
  const AudioContextClass = window.AudioContext
    ?? Reflect.get(window, "webkitAudioContext") as typeof AudioContext | undefined;
  if (!AudioContextClass) throw new Error("This desktop runtime cannot create a fixture audio stream.");
  const context = new AudioContextClass();
  const destination = context.createMediaStreamDestination();
  const sources = new Set<AudioBufferSourceNode>();
  await context.resume();
  return {
    stream: destination.stream,
    async play(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Station audio fixture could not be loaded (${response.status}).`);
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      const trailingFrames = Math.ceil(context.sampleRate * 0.9);
      const buffer = context.createBuffer(
        decoded.numberOfChannels,
        decoded.length + trailingFrames,
        context.sampleRate,
      );
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const output = buffer.getChannelData(channel);
        output.set(decoded.getChannelData(channel));
        for (let frame = decoded.length; frame < output.length; frame += 1) {
          // Keep WebRTC packetization alive long enough for server VAD to close
          // the turn. This level is intentionally far below audible speech.
          output[frame] = frame % 2 === 0 ? 0.0003 : -0.0003;
        }
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      sources.add(source);
      await new Promise<void>((resolve, reject) => {
        source.addEventListener("ended", () => {
          sources.delete(source);
          resolve();
        }, { once: true });
        try {
          source.start();
        } catch (error) {
          sources.delete(source);
          reject(error);
        }
      });
    },
    close() {
      for (const source of sources) {
        try { source.stop(); } catch {}
      }
      sources.clear();
      destination.stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
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

function opportunityScoutPrompt(context: string, handledGoals = realtime.handledGoals) {
  return [
    "[OpenWork Station opportunity scout]",
    "The user may still be speaking. Silently inspect this interim live context without waiting for end-of-turn.",
    "If there is exactly one concrete, non-speculative opportunity worth pursuing now, call propose_research_goal or propose_openwork_thread. Prefer a stable decision, blocker, commitment, named-context lookup, meeting-preparation need, or explicit request to continue the work.",
    "If the sentence is incomplete, the signal is vague, or the same goal is already pending or was recently handled, use no tool and output nothing. Never speak.",
    handledGoals.length
      ? `Recently approved or rejected goals (do not repeat): ${handledGoals.slice(-6).join(" · ")}`
      : "",
    "",
    context,
  ].filter(Boolean).join("\n");
}

function disconnectRealtime() {
  if (realtime.energyFrame !== null) window.cancelAnimationFrame(realtime.energyFrame);
  if (realtime.scoutTimer !== null) window.clearTimeout(realtime.scoutTimer);
  try { realtime.session?.close(); } catch {}
  try { realtime.stream?.getTracks().forEach((track) => track.stop()); } catch {}
  try { void realtime.audioContext?.close(); } catch {}
  try { realtime.fixturePlayback?.close(); } catch {}
  realtime.session = null;
  realtime.stream = null;
  realtime.audioContext = null;
  realtime.analyser = null;
  realtime.energyFrame = null;
  realtime.transcript.reset();
  realtime.requestedToolCalls.clear();
  realtime.scoutTimer = null;
  realtime.scoutInFlight = false;
  realtime.responseInFlight = false;
  realtime.lastScoutText = "";
  realtime.lastScoutCharacterCount = 0;
  realtime.lastScoutAt = 0;
  realtime.pendingScoutText = "";
  realtime.pendingScoutCharacterCount = 0;
  realtime.handledGoals = [];
  realtime.fixturePlayback = null;
}

function stageDemoSuggestions(stage: string) {
  if (stage === "processing") return [];
  if (stage === "memory") return DEMO_SUGGESTIONS.slice(0, 1);
  if (stage === "calendar") return DEMO_SUGGESTIONS.slice(0, 2);
  if (stage === "follow_up" || stage === "living") return DEMO_SUGGESTIONS;
  if (stage === "stopped") return DEMO_SUGGESTIONS;
  return [];
}

export function OpenWorkStationBridge(props: OpenWorkStationBridgeProps) {
  const [state, setState] = useState<StationState>(INITIAL_STATION_STATE);
  const stateRef = useRef(state);
  const analysisInFlightEpochRef = useRef<number | null>(null);
  const pendingAnalysisRef = useRef<{ epoch: number; transcript: string } | null>(null);
  const transcriptRef = useRef("");
  const runEpochRef = useRef(0);
  const handoffInFlightRef = useRef(false);
  const developmentOverrideRef = useRef(false);
  const scenarioTimersRef = useRef<number[]>([]);
  const scenarioStartedAtRef = useRef<number | null>(null);
  stateRef.current = state;

  const publish = useCallback((next: StationState) => {
    stateRef.current = next;
    setState(next);
    window.__OPENWORK_ELECTRON__?.station?.publishState?.(next);
  }, []);

  const updateState = useCallback((updater: (current: StationState) => StationState) => {
    publish(updater(stateRef.current));
  }, [publish]);

  const transitionRuntime = useCallback((event: StationRuntimeEvent) => {
    updateState((current) => {
      const runtime = transitionStationRuntime(current.runtime, event);
      if (runtime === current.runtime) return current;
      return {
        ...current,
        runtime,
        status: publicStatusForRuntime(runtime),
        statusText: stationPresentationText(runtime.presentation),
      };
    });
  }, [updateState]);

  const observeLifecycle = useCallback((
    name: StationLifecycleEventName,
    input: {
      id?: string;
      model?: string;
      tool?: string;
      resultCategory?: string;
      suggestionCount?: number;
      sourceCategory?: string;
    } = {},
  ) => {
    const observation = lifecycleObservation(name, stateRef.current.runtime.runId, input);
    recordInspectorEvent(name, observation);
    updateState((current) => {
      if (!current.scenario) return current;
      return {
        ...current,
        scenario: {
          ...current.scenario,
          observedEvents: [...current.scenario.observedEvents, observation].slice(-120),
        },
      };
    });
  }, [updateState]);

  const clearScenarioTimers = useCallback(() => {
    for (const timer of scenarioTimersRef.current) window.clearTimeout(timer);
    scenarioTimersRef.current = [];
    scenarioStartedAtRef.current = null;
  }, []);

  const analyzeTranscript = useCallback(async (transcript: string) => {
    if (!props.client || !props.workspaceId || !transcript.trim()) {
      return { ok: false, error: "A workspace and meaningful transcript are required." };
    }
    const requestEpoch = runEpochRef.current;
    if (analysisInFlightEpochRef.current === requestEpoch) {
      pendingAnalysisRef.current = { epoch: requestEpoch, transcript };
      return { ok: true, queued: true };
    }
    analysisInFlightEpochRef.current = requestEpoch;
    transitionRuntime({ type: "mcp_discovery_started" });
    observeLifecycle("station.mcp.discovery_started", {
      tool: stateRef.current.scenario?.status === "running"
        ? "development-mcp"
        : "openwork-connect",
      sourceCategory: stateRef.current.scenario?.status === "running"
        ? "development-mcp"
        : "openwork-connect",
    });
    updateState((current) => ({
      ...current,
      error: null,
    }));
    try {
      const sessionContext = await loadSessionContext(props.client, props.workspaceId, props.sessionId);
      const response = await props.client.getStationSuggestions(props.workspaceId, {
        transcript,
        ...(sessionContext ? { sessionContext } : {}),
        ...(stateRef.current.scenario?.status === "running"
          ? { scenarioId: stateRef.current.scenario.id }
          : {}),
      });
      if (requestEpoch !== runEpochRef.current) return { ok: false, cancelled: true };
      const connected = response.research.resultCategory === "connected-data";
      transitionRuntime({ type: "mcp_discovery_completed", found: connected });
      observeLifecycle("station.mcp.discovery_completed", {
        tool: response.research.executedCapabilities.join(","),
        resultCategory: response.research.resultCategory,
        sourceCategory: response.research.boundary,
      });
      updateState((current) => {
        const suggestions = rankStationSuggestions(current.suggestions, response.suggestions, transcript);
        const generatedIds = new Set(response.suggestions.map((suggestion) => suggestion.id));
        const generatedSelection = suggestions.find((suggestion) => generatedIds.has(suggestion.id));
        return {
          ...current,
          suggestions,
          selectedId: current.interactionMode === "active"
            ? generatedSelection?.id ?? suggestions[0]?.id ?? null
            : suggestions[0]?.id ?? null,
          source: response.source,
          error: null,
        };
      });
      transitionRuntime({ type: "suggestions_published", count: response.suggestions.length });
      observeLifecycle("station.suggestions_published", {
        suggestionCount: response.suggestions.length,
        resultCategory: response.suggestions.length ? "published" : "no-useful-context",
        sourceCategory: response.source,
      });
      return {
        ok: true,
        source: response.source,
        research: response.research,
        suggestionCount: response.suggestions.length,
      };
    } catch (error) {
      if (requestEpoch !== runEpochRef.current) return { ok: false, cancelled: true };
      transitionRuntime({ type: "recoverable_error" });
      updateState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (analysisInFlightEpochRef.current === requestEpoch) {
        analysisInFlightEpochRef.current = null;
      }
      const pending = pendingAnalysisRef.current;
      if (pending?.epoch === requestEpoch) pendingAnalysisRef.current = null;
      if (
        pending
        && pending.epoch === requestEpoch
        && pending.transcript !== transcript
        && requestEpoch === runEpochRef.current
      ) {
        void analyzeTranscript(pending.transcript);
      }
    }
  }, [
    observeLifecycle,
    props.client,
    props.sessionId,
    props.workspaceId,
    transitionRuntime,
    updateState,
  ]);

  const proposeGoal = useCallback((
    input: Pick<StationGoal, "kind" | "title" | "summary" | "reason" | "focus">,
  ) => {
    const existing = stateRef.current.goal;
    if (existing) return existing;
    const createdAt = Date.now();
    const title = input.title.trim().replace(/\s+/g, " ").slice(0, 100);
    const goal: StationGoal = {
      id: `station-goal-${createdAt}-${input.kind}`,
      kind: input.kind,
      title: title || (input.kind === "research" ? "look into this context" : "continue this work"),
      summary: input.summary.trim().replace(/\s+/g, " ").slice(0, 320),
      reason: input.reason.trim().replace(/\s+/g, " ").slice(0, 220),
      ...(input.focus ? { focus: input.focus } : {}),
      status: "proposed",
      createdAt,
    };
    updateState((current) => ({
      ...current,
      visible: true,
      goal,
      error: null,
    }));
    void window.__OPENWORK_ELECTRON__?.station?.show?.();
    return goal;
  }, [updateState]);

  const dismissGoal = useCallback(() => {
    const goal = stateRef.current.goal;
    if (!goal) return { ok: false, reason: "No Station goal is waiting." };
    const context = [transcriptRef.current.trim(), stateRef.current.partialTranscript.trim()]
      .filter(Boolean)
      .join("\n")
      .slice(-4_000);
    realtime.handledGoals = [...realtime.handledGoals, goal.title].slice(-6);
    realtime.lastScoutAt = Date.now();
    realtime.lastScoutText = context;
    realtime.lastScoutCharacterCount = context.length;
    realtime.pendingScoutText = context;
    realtime.pendingScoutCharacterCount = context.length;
    if (realtime.scoutTimer !== null) window.clearTimeout(realtime.scoutTimer);
    realtime.scoutTimer = null;
    updateState((current) => ({
      ...current,
      goal: null,
      error: null,
    }));
    transitionRuntime({ type: "decision_completed" });
    return { ok: true, goalId: goal.id, decision: "dismissed" };
  }, [transitionRuntime, updateState]);

  const approveGoal = useCallback(async () => {
    const goal = stateRef.current.goal;
    if (!goal) return { ok: false, reason: "No Station goal is waiting." };
    const transcript = transcriptRef.current.trim();
    if (!transcript) return { ok: false, reason: "No meaningful live transcript is available." };
    realtime.handledGoals = [...realtime.handledGoals, goal.title].slice(-6);
    updateState((current) => ({
      ...current,
      goal: current.goal ? { ...current.goal, status: "researching" } : null,
      error: null,
    }));
    if (goal.kind === "thread") {
      const suggestion = createLiveConversationSuggestion({
        title: goal.title,
        summary: goal.summary,
        reason: goal.reason,
      });
      updateState((current) => ({
        ...current,
        interactionMode: "active",
        visible: true,
        suggestions: rankStationSuggestions(current.suggestions, [suggestion], transcript),
        selectedId: suggestion.id,
        goal: null,
        source: "local-signal",
        error: null,
      }));
      transitionRuntime({ type: "suggestions_published", count: 1 });
      observeLifecycle("station.suggestions_published", {
        id: suggestion.id,
        suggestionCount: 1,
        resultCategory: "approved-live-thread",
        sourceCategory: "local-signal",
      });
      await window.__OPENWORK_ELECTRON__?.station?.show?.();
      return { ok: true, goalId: goal.id, suggestionId: suggestion.id };
    }
    const result = await analyzeTranscript(transcript);
    const hasSuggestions = result.ok
      && typeof result.suggestionCount === "number"
      && result.suggestionCount > 0;
    updateState((current) => ({
      ...current,
      interactionMode: hasSuggestions ? "active" : current.interactionMode,
      selectedId: hasSuggestions
        ? current.suggestions[0]?.id ?? current.selectedId
        : current.selectedId,
      goal: null,
    }));
    return { ...result, goalId: goal.id };
  }, [analyzeTranscript, observeLifecycle, transitionRuntime, updateState]);

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
      provenance: {
        inputSource: "simulated",
        inferenceMode: "simulation",
        model: null,
      },
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
    const completion = realtime.transcript.complete(itemId, clean);
    if (!completion.accepted) return;
    const combined = completion.transcript;
    transcriptRef.current = combined;
    updateState((current) => ({
      ...current,
      transcript: combined,
      partialTranscript: "",
    }));
    transitionRuntime({ type: "transcript_completed" });
    observeLifecycle("station.realtime.transcript_completed", {
      resultCategory: "transcribed",
    });
    const goalDecision = stateRef.current.goal ? stationGoalVoiceDecision(clean) : null;
    if (goalDecision === "approve") void approveGoal();
    if (goalDecision === "dismiss") dismissGoal();
  }, [approveGoal, dismissGoal, observeLifecycle, transitionRuntime, updateState]);

  const clearTranscript = useCallback(() => {
    transcriptRef.current = "";
    realtime.transcript.reset();
    updateState((current) => ({
      ...current,
      transcript: "",
      partialTranscript: "",
    }));
    return { ok: true };
  }, [updateState]);

  const scheduleOpportunityScout = useCallback((partialTranscript: string) => {
    const session = realtime.session;
    if (!session || stateRef.current.goal) return;
    const fullContext = [transcriptRef.current.trim(), partialTranscript.trim()]
      .filter(Boolean)
      .join("\n");
    if (partialTranscript.trim().length < 80 || fullContext.length < 160) return;
    realtime.pendingScoutText = fullContext.slice(-4_000);
    realtime.pendingScoutCharacterCount = fullContext.length;
    if (realtime.scoutInFlight || realtime.responseInFlight || realtime.scoutTimer !== null) return;
    const waitMs = Math.max(250, 3_200 - (Date.now() - realtime.lastScoutAt));
    realtime.scoutTimer = window.setTimeout(() => {
      realtime.scoutTimer = null;
      const latestSession = realtime.session;
      if (
        !latestSession
        || stateRef.current.goal
        || realtime.scoutInFlight
        || realtime.responseInFlight
        || realtime.pendingScoutCharacterCount - realtime.lastScoutCharacterCount < 120
      ) return;
      const context = realtime.pendingScoutText;
      if (!context || context === realtime.lastScoutText) return;
      realtime.scoutInFlight = true;
      realtime.lastScoutText = context;
      realtime.lastScoutCharacterCount = realtime.pendingScoutCharacterCount;
      realtime.lastScoutAt = Date.now();
      latestSession.sendMessage(opportunityScoutPrompt(context));
    }, waitMs);
  }, []);

  const handleRealtimeEvent = useCallback((event: unknown) => {
    const type = readString(event, "type");
    if (type === "response.created") {
      realtime.responseInFlight = true;
      transitionRuntime({ type: "response_started" });
      observeLifecycle("station.realtime.response_started", {
        resultCategory: "model-turn",
      });
      return;
    }
    if (type === "response.done") {
      realtime.scoutInFlight = false;
      realtime.responseInFlight = false;
      if (
        realtime.pendingScoutText
        && realtime.pendingScoutText !== realtime.lastScoutText
        && !stateRef.current.goal
      ) {
        scheduleOpportunityScout(stateRef.current.partialTranscript);
      }
      if (stateRef.current.runtime.phase !== "deciding") return;
      transitionRuntime({ type: "decision_completed" });
      observeLifecycle("station.suggestions_published", {
        suggestionCount: 0,
        resultCategory: "model-no-tool",
        sourceCategory: stateRef.current.source ?? "local-signal",
      });
      return;
    }
    if (type === "response.function_call_arguments.done" || type === "response.output_item.added") {
      const item = isRecord(event) && isRecord(event.item) ? event.item : {};
      const itemType = readString(item, "type");
      if (type === "response.output_item.added" && itemType !== "function_call") return;
      const callId = readString(event, "call_id") || readString(item, "call_id") || readString(item, "id");
      const toolName = readString(event, "name") || readString(item, "name") || "propose_research_goal";
      const requestId = callId || `${toolName}:${stateRef.current.runtime.runId}`;
      if (realtime.requestedToolCalls.has(requestId)) return;
      realtime.requestedToolCalls.add(requestId);
      transitionRuntime({ type: "tool_requested" });
      observeLifecycle("station.realtime.tool_requested", {
        id: requestId,
        tool: toolName,
        resultCategory: "model-issued",
      });
      return;
    }
    if (type === "conversation.item.created") {
      const item = isRecord(event) && isRecord(event.item) ? event.item : {};
      const itemId = readString(item, "id");
      if (itemId) realtime.transcript.markItem(itemId);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = readString(event, "item_id") || "active";
      const delta = readString(event, "delta");
      const partial = realtime.transcript.appendDelta(itemId, delta);
      updateState((current) => ({
        ...current,
        partialTranscript: partial,
      }));
      transitionRuntime({ type: "transcription_delta" });
      scheduleOpportunityScout(partial);
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = readString(event, "item_id") || "active";
      const transcript = readString(event, "transcript") || realtime.transcript.partial(itemId);
      completeTranscript(itemId, transcript);
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      transitionRuntime({ type: "speech_started" });
      observeLifecycle("station.realtime.speech_started", {
        resultCategory: "audio-detected",
      });
      return;
    }
    if (type === "error") {
      const error = isRecord(event) && isRecord(event.error) ? readString(event.error, "message") : "";
      updateState((current) => ({
        ...current,
        error: error || "OpenAI Realtime reported an error.",
      }));
      transitionRuntime({ type: "recoverable_error" });
      realtime.scoutInFlight = false;
    }
  }, [
    completeTranscript,
    observeLifecycle,
    scheduleOpportunityScout,
    transitionRuntime,
    updateState,
  ]);

  const stop = useCallback(async () => {
    const scenarioStartedAt = scenarioStartedAtRef.current;
    runEpochRef.current += 1;
    pendingAnalysisRef.current = null;
    clearScenarioTimers();
    disconnectRealtime();
    transitionRuntime({ type: "stop" });
    updateState((current) => ({
      ...current,
      listening: false,
      partialTranscript: "",
      audioEnergy: 0,
      error: null,
      visible: true,
      scenario: current.scenario
        ? { ...current.scenario, status: "stopped", timelineMs: Math.max(0, Date.now() - (scenarioStartedAt ?? Date.now())) }
        : null,
    }));
    observeLifecycle("station.realtime.stopped", {
      resultCategory: "session-closed",
    });
    return { ok: true };
  }, [clearScenarioTimers, observeLifecycle, transitionRuntime, updateState]);

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

  const start = useCallback(async (options: StationStartOptions = {}) => {
    if (
      stateRef.current.listening
      || stateRef.current.runtime.phase === "requesting_microphone"
      || stateRef.current.runtime.phase === "minting_client_secret"
      || stateRef.current.runtime.phase === "connecting"
    ) return { ok: true, alreadyListening: true };
    if (!props.client || !props.workspaceId) {
      transitionRuntime({ type: "terminal_error" });
      updateState((current) => ({
        ...current,
        visible: true,
        error: "Connect a workspace before starting Station.",
      }));
      return { ok: false, error: "OpenWork Station needs a connected workspace." };
    }
    const inputSource = options.inputSource ?? "microphone";
    const runEpoch = runEpochRef.current + 1;
    runEpochRef.current = runEpoch;
    transitionRuntime({ type: "start_requested" });
    await window.__OPENWORK_ELECTRON__?.station?.show?.();
    updateState((current) => ({
      ...current,
      visible: true,
      provenance: {
        inputSource,
        inferenceMode: "openai-realtime",
        model: null,
      },
      scenario: inputSource === "microphone" ? null : current.scenario,
      error: null,
    }));
    try {
      let stream = options.mediaStream;
      if (!stream) {
        transitionRuntime({ type: "microphone_requested" });
        if (!(await requestMicrophonePermission())) {
          throw new Error("Microphone access was not granted.");
        }
        if (runEpoch !== runEpochRef.current) return { ok: false, cancelled: true };
        transitionRuntime({ type: "microphone_ready" });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } else {
        transitionRuntime({ type: "microphone_ready" });
      }
      if (runEpoch !== runEpochRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, cancelled: true };
      }
      await monitorAudioEnergy(stream);
      const sessionContext = await loadSessionContext(props.client, props.workspaceId, props.sessionId);
      transitionRuntime({ type: "secret_requested" });
      observeLifecycle("station.realtime.secret_requested", {
        model: OPENWORK_STATION_REALTIME_MODEL,
        resultCategory: inputSource,
      });
      const credentials = await props.client.createStationRealtimeSession({
        ...(sessionContext ? { sessionContext } : {}),
      });
      if (runEpoch !== runEpochRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, cancelled: true };
      }
      transitionRuntime({ type: "secret_ready" });
      updateState((current) => ({
        ...current,
        provenance: {
          ...current.provenance,
          model: credentials.model,
        },
      }));
      const proposeResearchGoal = tool({
        name: "propose_research_goal",
        description: [
          "Propose one intentional read-only research goal for the accumulated meaningful work conversation.",
          "Use this when Slack, Gmail, or Google Calendar could resolve a question, recall prior context, expose a blocker or contradiction, verify a commitment or deadline, prepare for a meeting, or make the next step materially more useful.",
          "The user will see the goal as 'I'll look into …' and can approve or dismiss it before OpenWork Connect research begins.",
        ].join(" "),
        parameters: z.object({
          transcript: z.string()
            .min(1)
            .max(12_000)
            .describe("The meaningful spoken turn or conversation context that may deserve research."),
          goal: z.string()
            .min(1)
            .max(100)
            .describe("A concise lower-case phrase completing 'I'll …', such as 'look into Maya's launch concern'."),
          focus: z.enum([
            "prior_conversation",
            "person",
            "commitment",
            "calendar",
            "follow_up",
            "decision",
            "next_step",
          ]).optional().describe("The narrow reason connected context may be useful."),
        }),
        execute: async ({ transcript, goal, focus }) => {
          if (runEpoch !== runEpochRef.current) {
            return JSON.stringify({ ok: false, reason: "Station stopped before the goal was prepared." });
          }
          const latestTranscript = (transcriptRef.current.trim() || transcript.trim()).slice(-12_000);
          if (!latestTranscript) {
            return JSON.stringify({ ok: false, reason: "No meaningful transcript is available yet." });
          }
          const proposed = proposeGoal({
            kind: "research",
            title: goal,
            summary: "Use OpenWork Connect to find the most relevant Slack, Gmail, or Calendar context before preparing a result.",
            reason: "The live conversation contains a concrete question, risk, commitment, or preparation need that connected context may improve.",
            focus,
          });
          if (stateRef.current.interactionMode === "active") {
            const result = await approveGoal();
            return JSON.stringify({
              ok: result.ok,
              goalId: proposed.id,
              status: result.ok ? "approved_from_active_mode" : "approval_failed",
            });
          }
          return JSON.stringify({
            ok: true,
            goalId: proposed.id,
            status: "waiting_for_user",
          });
        },
      });
      const proposeOpenWorkThread = tool({
        name: "propose_openwork_thread",
        description: [
          "Propose one intentional local continuation goal from the accumulated live transcript when the user explicitly wants to continue, capture, develop, debug, or turn the current thought into work in OpenWork.",
          "Use this for direct requests for a card, suggestion, action, or OpenWork thread, and for a concrete unresolved work item that clearly deserves continued thinking.",
          "The user will see the goal and can approve or dismiss it. This does not claim Slack, Gmail, Calendar, or any external source.",
        ].join(" "),
        parameters: z.object({
          title: z.string().min(1).max(80)
            .describe("A concrete title for the work to continue in OpenWork."),
          summary: z.string().min(1).max(420)
            .describe("What the user is trying to understand, decide, design, or complete."),
          reason: z.string().min(1).max(220)
            .describe("Why continuing this specific thought is useful now."),
        }),
        execute: async ({ title, summary, reason }) => {
          if (runEpoch !== runEpochRef.current) {
            return JSON.stringify({ ok: false, reason: "Station stopped before the card was prepared." });
          }
          const transcript = transcriptRef.current.trim();
          if (!transcript) {
            return JSON.stringify({ ok: false, reason: "No meaningful live transcript is available." });
          }
          const proposed = proposeGoal({
            kind: "thread",
            title,
            summary,
            reason,
          });
          if (stateRef.current.interactionMode === "active") {
            const result = await approveGoal();
            return JSON.stringify({
              ok: result.ok,
              goalId: proposed.id,
              status: result.ok ? "approved_from_active_mode" : "approval_failed",
            });
          }
          return JSON.stringify({
            ok: true,
            goalId: proposed.id,
            status: "waiting_for_user",
          });
        },
      });
      const agent = new RealtimeAgent({
        name: "OpenWork Station",
        instructions: [
          "# Role and objective",
          "You are OpenWork Station, a silent passive AI right hand beside the user's live work conversation. Listen continuously, notice opportunities as the user speaks, propose one intentional goal, and research only goals the user approves. Never speak or address anyone in the room; text output is internal and is not shown as a chat reply.",
          "# Research decision",
          "After every completed meaningful work turn, decide whether one read-only lookup could materially help now. If yes, call propose_research_goal once with the accumulated relevant transcript, a concise intentional goal, and the narrowest focus. Be eager about useful read-only research, but selective about goals.",
          "Research when the conversation contains any of these signals: a named person, customer, project, or topic whose prior Slack or Gmail context would change the answer; a recalled decision, concern, promise, owner, blocker, deadline, or follow-up; a concrete meeting, date, time zone, attendee, availability question, conflict, or preparation need that Calendar could verify; an apparent contradiction or correction; or a moment where recent Slack, email, or calendar context would prevent the user from missing something important.",
          "For named people or projects, wait until there is a question, decision, risk, commitment, or preparation need—a name alone is not useful enough. Prefer the most recent and directly relevant context over broad history.",
          "# Quiet behavior",
          "Do not research greetings, introductions, filler, background speech, repetitions, casual conversation, vague ideas, or turns that already contain everything needed. Do not create a card merely to prove that you are listening.",
          "# Direct OpenWork continuation",
          "When the user explicitly asks for a card, suggestion, action, continuation, capture, debugging task, or a new OpenWork thread, call propose_openwork_thread even when Connect is unavailable. Also use it for a concrete unresolved plan, design choice, decision, or problem that clearly deserves continued work. Ground the title and summary only in the accumulated live transcript. This is a local continuation goal, not connected research. Prefer this tool over propose_research_goal when the user is asking to continue the current thought rather than retrieve private history.",
          "# Goal review",
          "Propose only one highest-value goal at a time. In passive mode, the user may approve it with Yes or reject it with No; do not perform connected research or publish a final card until approval. Active mode is explicit pre-approval for one immediate card, so the runtime may approve the proposed goal automatically. After a rejection, keep listening and look for a materially different useful goal rather than repeating the same one.",
          "# Corrections and continuity",
          "Use the accumulated latest context, not an isolated fragment. When a later turn corrects a person, date, duration, decision, or commitment, research again so stale context can be replaced rather than contradicted. If connected context was temporarily unavailable, retry only after a later turn makes the same context relevant again.",
          "# Authority",
          "Research is review-only. Never send a message, schedule an event, create or update a record, or imply that an external action happened. The only user-facing outcome is a contextual card they may continue as an OpenWork thread or dismiss.",
          sessionContext ? `Current OpenWork session context:\n${sessionContext}` : "",
        ].filter(Boolean).join("\n\n"),
        tools: [proposeResearchGoal, proposeOpenWorkThread],
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
                prompt: "OpenWork Station live work conversation. Preserve exact names, companies, projects, customer names, Slack channels, email subjects, dates, times, time zones, deadlines, decisions, corrections, owners, and commitments. Vocabulary may include OpenWork, Slack, Gmail, Google Calendar, MCP, and Realtime.",
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
      realtime.transcript.reset(transcriptRef.current);
      realtime.requestedToolCalls.clear();
      sdkSession.on("transport_event", (event) => {
        if (runEpoch !== runEpochRef.current) return;
        handleRealtimeEvent(event);
      });
      sdkSession.on("agent_tool_start", (_context, _agent, stationTool, details) => {
        if (runEpoch !== runEpochRef.current) return;
        const toolCallId = readString(details.toolCall, "callId")
          || readString(details.toolCall, "call_id")
          || `${stationTool.name}:${stateRef.current.runtime.runId}`;
        if (!realtime.requestedToolCalls.has(toolCallId)) {
          realtime.requestedToolCalls.add(toolCallId);
          transitionRuntime({ type: "tool_requested" });
          observeLifecycle("station.realtime.tool_requested", {
            id: toolCallId,
            tool: stationTool.name,
            resultCategory: "model-issued",
          });
        }
        transitionRuntime({ type: "tool_started" });
        observeLifecycle("station.realtime.tool_started", {
          id: toolCallId,
          tool: stationTool.name,
          resultCategory: "sdk-dispatched",
        });
        updateState((current) => ({ ...current, error: null }));
      });
      sdkSession.on("agent_tool_end", (_context, _agent, stationTool, result, details) => {
        if (runEpoch !== runEpochRef.current) return;
        const failed = /"ok"\s*:\s*false/i.test(result);
        const toolCallId = readString(details.toolCall, "callId")
          || readString(details.toolCall, "call_id")
          || `${stationTool.name}:${stateRef.current.runtime.runId}`;
        if (failed) {
          transitionRuntime({ type: "recoverable_error" });
          observeLifecycle("station.realtime.tool_failed", {
            id: toolCallId,
            tool: stationTool.name,
            resultCategory: "recoverable",
            sourceCategory: stateRef.current.source ?? undefined,
          });
          return;
        }
        transitionRuntime({ type: "tool_completed" });
        observeLifecycle("station.realtime.tool_completed", {
          id: toolCallId,
          tool: stationTool.name,
          resultCategory: "completed",
          suggestionCount: stateRef.current.suggestions.length,
          sourceCategory: stateRef.current.source ?? undefined,
        });
      });
      sdkSession.on("error", (event) => {
        if (runEpoch !== runEpochRef.current) return;
        realtime.scoutInFlight = false;
        realtime.responseInFlight = false;
        const detail = isRecord(event) ? event.error : event;
        const message = isRecord(detail) ? readString(detail, "message") : "";
        transitionRuntime({ type: "recoverable_error" });
        updateState((current) => ({
          ...current,
          error: message || "OpenAI Realtime reported an error.",
        }));
      });
      await sdkSession.connect({
        apiKey: credentials.clientSecret,
        model: credentials.model,
      });
      if (runEpoch !== runEpochRef.current) {
        sdkSession.close();
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, cancelled: true };
      }
      transitionRuntime({ type: "connected" });
      updateState((current) => ({
        ...current,
        visible: true,
        listening: true,
        audioEnergy: 0,
        error: null,
      }));
      observeLifecycle("station.realtime.connected", {
        model: credentials.model,
        resultCategory: inputSource,
      });
      return {
        ok: true,
        model: credentials.model,
        transcriptionModel: credentials.transcriptionModel,
      };
    } catch (error) {
      disconnectRealtime();
      if (runEpoch !== runEpochRef.current) return { ok: false, cancelled: true };
      const message = error instanceof Error ? error.message : String(error);
      transitionRuntime({
        type: /microphone access was not granted/i.test(message) ? "terminal_error" : "recoverable_error",
      });
      updateState((current) => ({
        ...current,
        visible: true,
        listening: false,
        audioEnergy: 0,
        error: message,
      }));
      return { ok: false, error: message };
    }
  }, [
    handleRealtimeEvent,
    monitorAudioEnergy,
    observeLifecycle,
    approveGoal,
    proposeGoal,
    props.client,
    props.sessionId,
    props.workspaceId,
    transitionRuntime,
    updateState,
  ]);

  const failScenario = useCallback((message: string) => {
    updateState((current) => ({
      ...current,
      scenario: current.scenario
        ? { ...current.scenario, status: "failed", error: message }
        : null,
      error: message,
    }));
  }, [updateState]);

  const executeScenarioStep = useCallback(async (
    scenario: StationScenario,
    step: StationScenarioStep,
    index: number,
    mode: StationScenarioRuntime["mode"],
  ) => {
    const startedAt = scenarioStartedAtRef.current;
    updateState((current) => ({
      ...current,
      scenario: current.scenario?.id === scenario.id
        ? {
            ...current.scenario,
            timelineMs: Math.max(0, Date.now() - (startedAt ?? Date.now())),
          }
        : current.scenario,
    }));
    if (!props.client || !props.workspaceId) {
      failScenario("A connected workspace is required for Station scenarios.");
      return;
    }
    try {
      if (step.kind === "connected_data_patch") {
        await props.client.controlStationScenario(props.workspaceId, {
          action: "apply",
          scenarioId: scenario.id,
          patchId: step.patchId,
        });
        return;
      }
      if (step.kind === "audio_utterance") {
        if (mode === "real-inference") {
          const playback = realtime.fixturePlayback;
          if (!playback) throw new Error("The real-audio fixture stream is unavailable.");
          await playback.play(step.audioFixture);
          return;
        }
        const itemId = `simulation:${scenario.id}:${index}`;
        completeTranscript(itemId, step.simulationTranscript);
        await analyzeTranscript(transcriptRef.current);
        return;
      }
      if (step.kind === "stop") {
        await stop();
      }
    } catch (error) {
      failScenario(error instanceof Error ? error.message : String(error));
    }
  }, [
    analyzeTranscript,
    completeTranscript,
    failScenario,
    props.client,
    props.workspaceId,
    stop,
    updateState,
  ]);

  const resetScenario = useCallback(async (args: unknown = {}) => {
    if (!import.meta.env.DEV) return { ok: false, error: "Station scenarios are development-only." };
    const scenarioId = isRecord(args) && typeof args.scenarioId === "string"
      ? args.scenarioId
      : stateRef.current.scenario?.id ?? "maya-memory";
    const scenario = stationScenarioById(scenarioId);
    if (!scenario) return { ok: false, error: `Unknown Station scenario: ${scenarioId}` };
    if (!props.client || !props.workspaceId) {
      return { ok: false, error: "A connected workspace is required for Station scenarios." };
    }
    if (stateRef.current.listening) await stop();
    clearScenarioTimers();
    disconnectRealtime();
    runEpochRef.current += 1;
    transcriptRef.current = "";
    transitionRuntime({ type: "reset" });
    const simulator = await props.client.controlStationScenario(props.workspaceId, {
      action: "reset",
      scenarioId: scenario.id,
      patchId: scenario.initialConnectedData,
    });
    const scenarioRuntime: StationScenarioRuntime = {
      id: scenario.id,
      title: scenario.title,
      status: "idle",
      mode: "real-inference",
      timelineMs: 0,
      playbackSpeed: 1,
      simulator: "development-mcp",
      observedEvents: [],
      error: null,
    };
    publish({
      ...INITIAL_STATION_STATE,
      runtime: stateRef.current.runtime,
      visible: true,
      scenario: scenarioRuntime,
    });
    return { ok: true, scenario: scenarioRuntime, simulator };
  }, [
    clearScenarioTimers,
    props.client,
    props.workspaceId,
    publish,
    stop,
    transitionRuntime,
  ]);

  const runScenario = useCallback(async (args: unknown) => {
    if (!import.meta.env.DEV) return { ok: false, error: "Station scenarios are development-only." };
    const scenarioId = isRecord(args) && typeof args.scenarioId === "string"
      ? args.scenarioId
      : "maya-memory";
    const scenario = stationScenarioById(scenarioId);
    if (!scenario) return { ok: false, error: `Unknown Station scenario: ${scenarioId}` };
    if (!props.client || !props.workspaceId) {
      return { ok: false, error: "A connected workspace is required for Station scenarios." };
    }
    const requestedSpeed = isRecord(args) && typeof args.playbackSpeed === "number"
      ? args.playbackSpeed
      : 1;
    const playbackSpeed = Math.min(4, Math.max(0.25, requestedSpeed));
    const realInference = !isRecord(args) || args.realInference !== false;
    const resetBeforeRun = !isRecord(args) || args.resetBeforeRun !== false;
    const stopAfterRun = isRecord(args) && args.stopAfterRun === true;
    if (resetBeforeRun) {
      const reset = await resetScenario({ scenarioId });
      if (!reset.ok) return reset;
    } else if (stateRef.current.listening) {
      await stop();
    }
    const mode: StationScenarioRuntime["mode"] = realInference ? "real-inference" : "simulation";
    const scenarioRuntime: StationScenarioRuntime = {
      id: scenario.id,
      title: scenario.title,
      status: "starting",
      mode,
      timelineMs: 0,
      playbackSpeed,
      simulator: "development-mcp",
      observedEvents: [],
      error: null,
    };
    publish({
      ...stateRef.current,
      provenance: realInference
        ? {
            inputSource: "fixture",
            inferenceMode: "openai-realtime",
            model: OPENWORK_STATION_REALTIME_MODEL,
          }
        : {
            inputSource: "simulated",
            inferenceMode: "simulation",
            model: null,
          },
      visible: true,
      transcript: "",
      partialTranscript: "",
      suggestions: [],
      selectedId: null,
      source: null,
      error: null,
      scenario: scenarioRuntime,
    });
    transcriptRef.current = "";
    if (realInference) {
      const playback = await createFixturePlayback();
      realtime.fixturePlayback = playback;
      const started = await start({ mediaStream: playback.stream, inputSource: "fixture" });
      if (!started.ok) {
        failScenario("error" in started && typeof started.error === "string"
          ? started.error
          : "The real Realtime fixture session did not start.");
        return started;
      }
    } else {
      transitionRuntime({ type: "connected" });
      updateState((current) => ({
        ...current,
        listening: true,
        scenario: current.scenario ? { ...current.scenario, status: "running" } : null,
      }));
    }
    scenarioStartedAtRef.current = Date.now();
    updateState((current) => ({
      ...current,
      scenario: current.scenario ? { ...current.scenario, status: "running" } : null,
    }));
    for (const { delayMs, step } of scheduledStationScenarioSteps(scenario, playbackSpeed)) {
      const index = scenario.steps.indexOf(step);
      const timer = window.setTimeout(() => {
        void executeScenarioStep(scenario, step, index, mode);
      }, delayMs);
      scenarioTimersRef.current.push(timer);
    }
    const durationMs = stationScenarioDuration(scenario, playbackSpeed);
    let checks = 0;
    const outcomeTimer = window.setInterval(() => {
      checks += 1;
      const scenarioState = stateRef.current.scenario;
      if (!scenarioState || scenarioState.id !== scenario.id) {
        window.clearInterval(outcomeTimer);
        return;
      }
      updateState((current) => ({
        ...current,
        scenario: current.scenario
          ? {
              ...current.scenario,
              timelineMs: Math.max(0, Date.now() - (scenarioStartedAtRef.current ?? Date.now())),
            }
          : null,
      }));
      if ((scenarioState.timelineMs < durationMs && checks < 60) || scenarioState.status !== "running") return;
      const outcome = evaluateStationScenario(scenario, {
        observedEvents: scenarioState.observedEvents,
        suggestions: stateRef.current.suggestions,
        listening: stateRef.current.listening,
      });
      if (outcome.status === "pending" && checks < 60) return;
      window.clearInterval(outcomeTimer);
      updateState((current) => ({
        ...current,
        scenario: current.scenario
          ? {
              ...current.scenario,
              status: outcome.status === "passed" ? "completed" : "failed",
              error: outcome.status === "passed" ? null : outcome.reason ?? "Scenario expectations were not met.",
            }
          : null,
      }));
      if (outcome.status === "passed" && stopAfterRun) void stop();
    }, 500);
    scenarioTimersRef.current.push(outcomeTimer);
    return {
      ok: true,
      scenarioId: scenario.id,
      mode,
      playbackSpeed,
      durationMs,
      simulator: "development-mcp",
    };
  }, [
    executeScenarioStep,
    failScenario,
    props.client,
    props.workspaceId,
    publish,
    resetScenario,
    start,
    stop,
    transitionRuntime,
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

  const handoffSuggestion = useCallback(async (id: string | undefined) => {
    if (handoffInFlightRef.current) {
      return { ok: false, error: "A Station handoff is already opening." };
    }
    const suggestion = stateRef.current.suggestions.find((item) => item.id === id)
      ?? stateRef.current.suggestions.find((item) => item.id === stateRef.current.selectedId);
    if (!suggestion) return { ok: false, error: "Suggestion not found." };
    handoffInFlightRef.current = true;
    updateState((current) => ({
      ...current,
      statusText: "Opening in OpenWork…",
    }));
    try {
      const handoff = buildStationThreadHandoff(suggestion, {
        transcript: transcriptRef.current,
        includeTranscriptRecord: stateRef.current.transcriptRecordEnabled,
      });
      const threadId = await props.onCreateThread(handoff);
      if (!threadId) throw new Error("OpenWork could not create the Station thread.");
      updateState((current) => ({
        ...current,
        interactionMode: "passive",
        statusText: "Continuing in OpenWork",
      }));
      return { ok: true, threadId, title: handoff.title };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateState((current) => ({
        ...current,
        error: message,
        statusText: "Needs attention",
      }));
      return { ok: false, error: message };
    } finally {
      handoffInFlightRef.current = false;
    }
  }, [props.onCreateThread, updateState]);

  const setInteractionMode = useCallback(async (active: boolean) => {
    const interactionMode = active ? "active" : "passive";
    updateState((current) => ({
      ...current,
      interactionMode,
      selectedId: active ? current.suggestions[0]?.id ?? null : current.selectedId,
    }));
    if (!active) {
      return { ok: true, interactionMode, listening: stateRef.current.listening };
    }
    if (!stateRef.current.listening) {
      const started = await start();
      if (!started.ok) return started;
    }
    if (stateRef.current.goal) {
      const result = await approveGoal();
      return { ...result, interactionMode, activatedGoal: true };
    }
    if (stateRef.current.suggestions.length > 0) {
      return {
        ok: true,
        interactionMode,
        listening: stateRef.current.listening,
        suggestionCount: stateRef.current.suggestions.length,
      };
    }
    const context = [transcriptRef.current.trim(), stateRef.current.partialTranscript.trim()]
      .filter(Boolean)
      .join("\n")
      .slice(-4_000);
    if (!context || !realtime.session) {
      return {
        ok: true,
        interactionMode,
        listening: stateRef.current.listening,
        waitingForContext: true,
      };
    }
    if (!realtime.responseInFlight) {
      realtime.scoutInFlight = true;
      realtime.lastScoutText = context;
      realtime.lastScoutCharacterCount = context.length;
      realtime.lastScoutAt = Date.now();
      realtime.session.sendMessage([
        opportunityScoutPrompt(context),
        "",
        "Active mode was just enabled. Select the strongest useful continuation and call a tool now unless the context is genuinely unusable.",
      ].join("\n"));
    }
    return {
      ok: true,
      interactionMode,
      listening: stateRef.current.listening,
      scouting: true,
    };
  }, [approveGoal, start, updateState]);

  const seedDemo = useCallback(async (args: unknown) => {
    if (import.meta.env.DEV) {
      developmentOverrideRef.current = true;
      await window.__OPENWORK_ELECTRON__?.station?.setEnabled?.(true);
    }
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
    const resetRuntime = transitionStationRuntime(stateRef.current.runtime, { type: "reset", at: demoNow });
    let runtime = transitionStationRuntime(
      resetRuntime,
      listening ? { type: "connected", at: demoNow + 1 } : { type: "stop", at: demoNow + 1 },
    );
    if (stage === "processing") {
      runtime = transitionStationRuntime(runtime, { type: "speech_started", at: demoNow + 2 });
      runtime = transitionStationRuntime(runtime, { type: "transcription_delta", at: demoNow + 3 });
    }
    transcriptRef.current = stage === "wake"
      ? ""
      : stage === "listening"
      ? "Maya, do you remember what I told you last week?"
      : "Maya asked about last week’s launch concern. We discussed meeting at 2 PM Denver time, and I promised to follow up after the call.";
    publish({
      status: publicStatusForRuntime(runtime),
      statusText: stationPresentationText(runtime.presentation),
      interactionMode: stateRef.current.interactionMode,
      runtime,
      provenance: {
        inputSource: "simulated",
        inferenceMode: "simulation",
        model: null,
      },
      listening,
      visible: true,
      transcript: transcriptRef.current,
      partialTranscript: "",
      audioEnergy: listening ? 0.24 : 0,
      suggestions,
      selectedId,
      goal: null,
      transcriptRecordEnabled: stateRef.current.transcriptRecordEnabled,
      source: "demo",
      scenario: null,
      error: null,
    });
    await window.__OPENWORK_ELECTRON__?.station?.show?.();
    await window.__OPENWORK_ELECTRON__?.station?.setExpanded?.(false);
    return { ok: true, stage, suggestionCount: suggestions.length };
  }, [publish]);

  const handleCommand = useCallback(async (command: StationCommand) => {
    if (command.type === "start") return start();
    if (command.type === "stop") return stop();
    if (command.type === "clear-transcript") return clearTranscript();
    if (command.type === "approve-goal") return approveGoal();
    if (command.type === "dismiss-goal") return dismissGoal();
    if (command.type === "set-transcript-record") {
      const enabled = command.enabled === true;
      updateState((current) => ({ ...current, transcriptRecordEnabled: enabled }));
      return { ok: true, enabled };
    }
    if (command.type === "toggle-listening") return stateRef.current.listening ? stop() : start();
    if (command.type === "activate") return activateSuggestion(command.id);
    if (command.type === "handoff") return handoffSuggestion(command.id);
    if (command.type === "set-mode") return setInteractionMode(command.active === true);
    if (command.type === "previous" || command.type === "next") {
      const selectedId = stationHistorySelection(
        stateRef.current.suggestions,
        stateRef.current.selectedId,
        command.type === "previous" ? "older" : "newer",
      );
      updateState((current) => ({ ...current, selectedId }));
      return { ok: true, selectedId };
    }
    if (command.type === "dismiss") {
      updateState((current) => {
        const dismissal = stationDismissal(
          current.suggestions,
          current.selectedId,
          command.id ?? null,
        );
        return {
          ...current,
          interactionMode: dismissal.returnToPassive ? "passive" : current.interactionMode,
          suggestions: dismissal.suggestions,
          selectedId: dismissal.selectedId,
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
  }, [
    approveGoal,
    activateSuggestion,
    clearTranscript,
    dismissGoal,
    handoffSuggestion,
    seedDemo,
    setInteractionMode,
    start,
    stop,
    updateState,
  ]);

  useEffect(() => {
    const onCommand = window.__OPENWORK_ELECTRON__?.station?.onCommand;
    if (!onCommand) return undefined;
    return onCommand((value) => {
      if (isStationCommand(value)) void handleCommand(value);
    });
  }, [handleCommand]);

  useEffect(() => {
    const nativeStation = window.__OPENWORK_ELECTRON__?.station;
    if (!props.enabled) {
      if (developmentOverrideRef.current) return undefined;
      runEpochRef.current += 1;
      pendingAnalysisRef.current = null;
      clearScenarioTimers();
      disconnectRealtime();
      publish({
        ...INITIAL_STATION_STATE,
        runtime: transitionStationRuntime(stateRef.current.runtime, { type: "reset" }),
      });
      void nativeStation?.setEnabled?.(false);
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const result = await nativeStation?.setEnabled?.(true);
      if (cancelled || result?.ok === false) return;
      window.__OPENWORK_ELECTRON__?.station?.publishState?.(stateRef.current);
      await start();
    })();
    return () => {
      cancelled = true;
    };
  }, [clearScenarioTimers, props.enabled, publish, start]);

  useEffect(() => {
    window.__OPENWORK_ELECTRON__?.station?.publishState?.(stateRef.current);
  }, []);

  useEffect(() => () => {
    disconnectRealtime();
    if (developmentOverrideRef.current && !props.enabled) {
      void window.__OPENWORK_ELECTRON__?.station?.setEnabled?.(false);
    }
  }, [props.enabled]);

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

  useEffect(() => publishInspectorSlice("station", () => ({
    status: state.status,
    statusText: state.statusText,
    interactionMode: state.interactionMode,
    runtime: state.runtime,
    provenance: state.provenance,
    listening: state.listening,
    visible: state.visible,
    transcript: {
      completedCharacters: state.transcript.length,
      partialCharacters: state.partialTranscript.length,
    },
    audioEnergy: state.audioEnergy,
    suggestions: state.suggestions,
    selectedId: state.selectedId,
    goal: state.goal,
    transcriptRecordEnabled: state.transcriptRecordEnabled,
    source: state.source,
    scenario: state.scenario,
    error: state.error,
  })), [state]);

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
    disabled: !props.enabled || !props.client || state.listening,
    execute: () => start(),
  }), [props.client, props.enabled, start, state.listening]);
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

  const modeAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.mode.set",
    label: "Set OpenWork Station interaction mode",
    description: "Mirror the Station shortcut: active surfaces priority cards; passive keeps research running quietly.",
    sideEffect: "external",
    requiresArgs: true,
    args: [{
      name: "active",
      type: "boolean",
      required: true,
      description: "true for active mode, false for passive mode.",
    }],
    execute: (args) => setInteractionMode(isRecord(args) && args.active === true),
  }), [setInteractionMode]);
  useControlAction(modeAction);

  const seedAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.seed_demo",
    label: "Load the Station interaction scenario",
    description: "Deterministic interaction hook for exercising the passive Station surface.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [{ name: "stage", type: "string", required: true, description: "listening, processing, memory, living, calendar, follow_up, or stopped" }],
    previewArgs: { stage: "living" },
    execute: seedDemo,
  }), [seedDemo]);
  useControlAction(import.meta.env.DEV ? seedAction : null);

  const scenarioAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.scan_scenario",
    label: "Scan a conversation with OpenWork Station",
    description: "Simulation only: inject transcript text directly into the contextual analysis path.",
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
  useControlAction(import.meta.env.DEV ? scenarioAction : null);

  const runScenarioAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.scenario.run",
    label: "Run a time-sequenced Station scenario",
    description: "Development-only scenario playback. Real-inference mode sends audio fixtures through WebRTC.",
    sideEffect: "external",
    requiresArgs: true,
    args: [
      { name: "scenarioId", type: "string", required: true, description: "Declarative scenario id." },
      { name: "playbackSpeed", type: "number", description: "Timeline speed from 0.25 to 4." },
      { name: "realInference", type: "boolean", description: "Use real audio, WebRTC, Realtime inference, and model tool selection." },
      { name: "resetBeforeRun", type: "boolean", description: "Reset Station and connected simulator state first." },
      { name: "stopAfterRun", type: "boolean", description: "Stop the Realtime session after a passing run." },
    ],
    previewArgs: {
      scenarioId: "maya-memory",
      playbackSpeed: 1,
      realInference: true,
      resetBeforeRun: true,
      stopAfterRun: false,
    },
    execute: async (args) => {
      developmentOverrideRef.current = true;
      await window.__OPENWORK_ELECTRON__?.station?.setEnabled?.(true);
      return runScenario(args);
    },
  }), [runScenario]);
  useControlAction(import.meta.env.DEV ? runScenarioAction : null);

  const resetScenarioAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.scenario.reset",
    label: "Reset a Station scenario",
    description: "Development-only reset of Station and its MCP-shaped connected-data simulator.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [{ name: "scenarioId", type: "string", required: true, description: "Declarative scenario id." }],
    previewArgs: { scenarioId: "maya-memory" },
    execute: resetScenario,
  }), [resetScenario]);
  useControlAction(import.meta.env.DEV ? resetScenarioAction : null);

  const scenarioStatusAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.scenario.status",
    label: "Read Station scenario state",
    description: "Return timeline state and sanitized lifecycle observations without transcript bodies.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => ({
      scenario: stateRef.current.scenario,
      runtime: stateRef.current.runtime,
      interactionMode: stateRef.current.interactionMode,
      listening: stateRef.current.listening,
      audioEnergy: stateRef.current.audioEnergy,
      source: stateRef.current.source,
      suggestionCount: stateRef.current.suggestions.length,
      suggestionKinds: stateRef.current.suggestions.map((suggestion) => suggestion.kind),
      sourceProviders: Array.from(new Set(
        stateRef.current.suggestions.flatMap((suggestion) => (
          suggestion.sources.map((source) => source.provider)
        )),
      )),
      reviewOnly: stateRef.current.suggestions.every((suggestion) => (
        suggestion.action.kind === "none"
        || suggestion.action.kind === "open_source"
        || suggestion.action.kind === "review_draft"
      )),
      transcript: {
        completedCharacters: stateRef.current.transcript.length,
        partialCharacters: stateRef.current.partialTranscript.length,
      },
      error: stateRef.current.error,
    }),
  }), []);
  useControlAction(import.meta.env.DEV ? scenarioStatusAction : null);

  const scoutNowAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.scout.run",
    label: "Run the Station opportunity scout now",
    description: "Development-only: ask the live Realtime model to inspect the actual captured transcript for one intentional goal.",
    sideEffect: "external",
    disabled: !state.listening || !state.transcript.trim() || state.goal !== null,
    execute: () => {
      const session = realtime.session;
      const context = transcriptRef.current.trim().slice(-4_000);
      if (!session || !context) return { ok: false, reason: "A live Realtime session and transcript are required." };
      if (stateRef.current.goal) return { ok: false, reason: "A Station goal is already waiting." };
      if (realtime.responseInFlight) return { ok: false, reason: "The live model is already evaluating context." };
      realtime.scoutInFlight = true;
      realtime.lastScoutText = context;
      realtime.lastScoutCharacterCount = transcriptRef.current.length;
      realtime.lastScoutAt = Date.now();
      session.sendMessage(opportunityScoutPrompt(context));
      return { ok: true, capturedCharacters: context.length };
    },
  }), [state.goal, state.listening, state.transcript]);
  useControlAction(import.meta.env.DEV ? scoutNowAction : null);

  const selectAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.select",
    label: "Select a Station suggestion",
    description: "Select a card in the ordered Station history by id.",
    sideEffect: "none",
    requiresArgs: true,
    args: [{ name: "id", type: "string", required: true, description: "Suggestion id." }],
    execute: (args) => handleCommand({
      type: "select",
      id: isRecord(args) && typeof args.id === "string" ? args.id : undefined,
    }),
  }), [handleCommand]);
  useControlAction(selectAction);

  const historyAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.history.navigate",
    label: "Navigate Station card history",
    description: "Move to an older or newer card using the same ordered history as the arrow shortcuts.",
    sideEffect: "none",
    requiresArgs: true,
    args: [{
      name: "direction",
      type: "string",
      required: true,
      description: "older mirrors Left Arrow; newer mirrors Right Arrow.",
    }],
    execute: (args) => handleCommand({
      type: isRecord(args) && args.direction === "newer" ? "next" : "previous",
    }),
  }), [handleCommand]);
  useControlAction(historyAction);

  const dismissAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.dismiss",
    label: "Dismiss the selected Station card",
    description: "Mirror Escape / Not now and deal the next priority card if one exists.",
    sideEffect: "mutation",
    execute: () => handleCommand({
      type: "dismiss",
      id: stateRef.current.selectedId ?? undefined,
    }),
  }), [handleCommand]);
  useControlAction(dismissAction);

  const handoffAction = useMemo<OpenworkControlAction>(() => ({
    id: "station.handoff",
    label: "Continue a Station card in OpenWork",
    description: "Create and start an OpenWork thread with the selected Station context.",
    sideEffect: "external",
    execute: () => handoffSuggestion(stateRef.current.selectedId ?? undefined),
  }), [handoffSuggestion]);
  useControlAction(handoffAction);

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
    execute: () => ({
      status: stateRef.current.status,
      statusText: stateRef.current.statusText,
      interactionMode: stateRef.current.interactionMode,
      runtime: stateRef.current.runtime,
      listening: stateRef.current.listening,
      visible: stateRef.current.visible,
      audioEnergy: stateRef.current.audioEnergy,
      suggestions: stateRef.current.suggestions,
      selectedId: stateRef.current.selectedId,
      goal: stateRef.current.goal,
      transcriptRecordEnabled: stateRef.current.transcriptRecordEnabled,
      source: stateRef.current.source,
      scenario: stateRef.current.scenario,
      transcript: {
        completedCharacters: stateRef.current.transcript.length,
        partialCharacters: stateRef.current.partialTranscript.length,
      },
      error: stateRef.current.error,
    }),
  }), []);
  useControlAction(statusAction);

  return null;
}
