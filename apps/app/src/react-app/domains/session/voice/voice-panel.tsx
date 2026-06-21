/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Loader2, Mic2, MicOff, Radio, SendHorizontal, Sparkles, Square, X } from "lucide-react";
import { PaperGrainGradient } from "@openwork/ui/react";

import { desktopFetch } from "@/app/lib/desktop";
import type { OpenworkServerClient, OpenworkSessionMessage } from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { publishInspectorSlice, recordInspectorEvent } from "@/app/lib/app-inspector";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";

type VoiceStatus = "idle" | "connecting" | "listening" | "muted" | "speaking" | "error";

type VoiceTimelineEntry = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
  error?: boolean;
  at: number;
};

type VoiceRuntimeSnapshot = {
  status: VoiceStatus;
  statusText: string;
  micMuted: boolean;
  micDiagnostics: string;
  realtimeDiagnostics: string;
  entries: VoiceTimelineEntry[];
  latestUserTranscript: string;
  assistantPreview: string;
};

type VoicePanelProps = {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  sessionId: string | null;
  onClose: () => void;
};

const DEFAULT_TEXT_COMMAND = "Summarize the current OpenWork session and put the next step in the composer.";
const VOICE_SUGGESTIONS = [
  "Read the latest message in this session",
  "Put a concise next step in the composer",
  "Open extension settings",
  "Send the current composer prompt",
];
const TOOL_LABELS: Record<string, string> = {
  openwork_snapshot: "Checking OpenWork",
  openwork_list_actions: "Listing controls",
  openwork_execute_action: "Running UI action",
};

const initialVoiceRuntimeSnapshot: VoiceRuntimeSnapshot = {
  status: "idle",
  statusText: "Ready for voice control.",
  micMuted: false,
  micDiagnostics: "Microphone has not started yet.",
  realtimeDiagnostics: "Realtime is not connected.",
  entries: [],
  latestUserTranscript: "",
  assistantPreview: "",
};

const voiceRealtime = {
  peer: null as RTCPeerConnection | null,
  channel: null as RTCDataChannel | null,
  stream: null as MediaStream | null,
  remoteAudio: null as HTMLAudioElement | null,
  assistantBuffer: "",
  responseInProgress: false,
  pendingResponse: false,
  micMuted: false,
};

let voiceRuntimeSnapshot: VoiceRuntimeSnapshot = initialVoiceRuntimeSnapshot;
const voiceRuntimeListeners = new Set<() => void>();

function getVoiceRuntimeSnapshot() {
  return voiceRuntimeSnapshot;
}

function subscribeVoiceRuntime(listener: () => void) {
  voiceRuntimeListeners.add(listener);
  return () => {
    voiceRuntimeListeners.delete(listener);
  };
}

function setVoiceRuntimeSnapshot(update: (current: VoiceRuntimeSnapshot) => VoiceRuntimeSnapshot) {
  voiceRuntimeSnapshot = update(voiceRuntimeSnapshot);
  voiceRuntimeListeners.forEach((listener) => listener());
}

function useVoiceRuntimeSnapshot() {
  return useSyncExternalStore(subscribeVoiceRuntime, getVoiceRuntimeSnapshot, getVoiceRuntimeSnapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function readRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const field = value[key];
  return isRecord(field) ? field : {};
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ ok: false, error: "Could not serialize tool result" });
  }
}

function humanToolLabel(toolName?: string) {
  if (!toolName) return "OpenWork action";
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ");
}

function relativeTime(at: number) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function isMeaningfulTranscript(value: string) {
  return /[\p{Letter}\p{Number}]/u.test(value);
}

function voiceTextArgument(args: unknown) {
  if (typeof args === "string") return args.trim();
  if (isRecord(args) && typeof args.text === "string") return args.text.trim();
  return DEFAULT_TEXT_COMMAND;
}

function voiceAudioArgument(args: unknown) {
  if (!isRecord(args)) return "";
  return typeof args.pcm16Base64 === "string" ? args.pcm16Base64.trim() : "";
}

function messageText(message: OpenworkSessionMessage) {
  return message.parts
    .flatMap((part) => {
      if (part.type !== "text") return [];
      if (part.synthetic || part.ignored) return [];
      const text = part.text.trim();
      return text ? [text] : [];
    })
    .join("\n")
    .trim();
}

function buildVoiceSessionContext(messages: OpenworkSessionMessage[]) {
  const transcript = messages.flatMap((message, index) => {
    const role = message.info.role;
    if (role !== "user" && role !== "assistant") return [];
    const text = messageText(message);
    return text ? [{ index, role, text }] : [];
  });

  const included = new Set<number>();
  let assistantCount = 0;
  for (let index = transcript.length - 1; index >= 0 && assistantCount < 3; index -= 1) {
    const item = transcript[index];
    if (!item || item.role !== "assistant") continue;
    included.add(item.index);
    assistantCount += 1;
    const previous = transcript[index - 1];
    if (previous?.role === "user") included.add(previous.index);
  }

  const entries = transcript.filter((item) => included.has(item.index));
  if (!entries.length) return "";
  return entries
    .map((item) => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.text}`)
    .join("\n\n")
    .slice(0, 6_000);
}

async function loadVoiceSessionContext(client: OpenworkServerClient, workspaceId: string | null, sessionId: string | null) {
  if (!workspaceId || !sessionId) return "";
  try {
    const response = await client.getSessionMessages(workspaceId, sessionId, { limit: 40 });
    return buildVoiceSessionContext(response.items);
  } catch {
    return "";
  }
}

function waitForDataChannelOpen(channel: RTCDataChannel) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Realtime data channel did not open in time."));
    }, 10_000);
    const handleOpen = () => { cleanup(); resolve(); };
    const handleClose = () => { cleanup(); reject(new Error("Realtime data channel closed before opening.")); };
    const handleError = () => { cleanup(); reject(new Error("Realtime data channel failed.")); };
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

function describeAudioTrack(track: MediaStreamTrack | undefined) {
  if (!track) return "No microphone track is attached.";
  const muted = track.muted ? "muted by the system" : "not muted by the system";
  const enabled = track.enabled ? "enabled" : "disabled";
  return `Microphone track is ${track.readyState}, ${enabled}, and ${muted}.`;
}

function setMicDiagnostics(stream: MediaStream | null) {
  const track = stream?.getAudioTracks()[0];
  setVoiceRuntimeSnapshot((current) => ({ ...current, micDiagnostics: describeAudioTrack(track) }));
}

function setRealtimeDiagnostics(text: string) {
  setVoiceRuntimeSnapshot((current) => ({ ...current, realtimeDiagnostics: text }));
}

async function requestMacMicrophoneAccess() {
  const ask = window.__OPENWORK_ELECTRON__?.system?.askMicrophoneAccess;
  if (!ask) return true;
  const result = await ask();
  if (result.platform !== "darwin") return true;
  const status = result.after ?? result.before ?? result.status ?? "unknown";
  setVoiceRuntimeSnapshot((current) => ({ ...current, micDiagnostics: `macOS microphone permission is ${status}.` }));
  return result.granted;
}

async function executeOpenWorkTool(name: string, args: Record<string, unknown>) {
  const control = window.__openworkControl;
  if (!control) return { ok: false, error: "OpenWork control surface is not available." };

  if (name === "openwork_snapshot") return { ok: true, snapshot: control.snapshot() };
  if (name === "openwork_list_actions") return { ok: true, actions: control.listActions() };
  if (name === "openwork_execute_action") {
    const actionId = typeof args.actionId === "string" ? args.actionId.trim() : "";
    if (!actionId) return { ok: false, error: "Missing actionId." };
    const actionArgs = isRecord(args.args) ? args.args : {};
    return control.execute(actionId, actionArgs);
  }

  return { ok: false, error: `Unknown OpenWork voice tool: ${name}` };
}

function VoiceOrb(props: { status: VoiceStatus; muted: boolean }) {
  const active = props.status === "listening" || props.status === "speaking";
  const colors = props.status === "speaking"
    ? ["#fb7185", "#fbbf24", "#818cf8", "#111827"]
    : props.muted
      ? ["#94a3b8", "#475569", "#cbd5e1", "#0f172a"]
      : ["#8ddde7", "#4f8b7b", "#bfdfa4", "#102b24"];

  return (
    <div className="relative mx-auto flex size-34 items-center justify-center rounded-full border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
      <div className="absolute inset-2 overflow-hidden rounded-full">
        <PaperGrainGradient
          speed={props.status === "speaking" ? 18 : active ? 12 : 4}
          softness={0.16}
          intensity={1}
          noise={0.06}
          shape="sphere"
          colors={colors}
          colorBack="#ffffff00"
          style={{ width: "100%", height: "100%", borderRadius: "9999px" }}
        />
      </div>
      <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_32%_20%,rgba(255,255,255,0.55),transparent_26%)]" />
      <div className={cn(
        "absolute -bottom-2 rounded-full border border-border bg-background px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm",
        active && "text-foreground",
      )}>
        {props.status === "speaking" ? "Speaking" : props.muted ? "Muted" : active ? "Listening" : "Ready"}
      </div>
    </div>
  );
}

function VoiceTimelineRow(props: {
  entry: VoiceTimelineEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { entry } = props;
  const isAction = entry.role === "tool" || entry.role === "system";
  const canExpand = isAction && entry.text.length > 72;
  const copy = canExpand && !props.expanded ? `${entry.text.slice(0, 72)}...` : entry.text;

  if (entry.role === "user") {
    return (
      <article className="ml-8 rounded-2xl border border-primary/20 bg-primary/10 px-3 py-2 text-sm leading-relaxed text-foreground">
        {entry.text}
      </article>
    );
  }

  if (entry.role === "assistant") {
    return (
      <article className="mr-8 rounded-2xl border border-border bg-card px-3 py-2 text-sm leading-relaxed text-card-foreground shadow-sm">
        {entry.error ? <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-destructive">Error</div> : null}
        <div className="whitespace-pre-wrap break-words">{entry.text}</div>
      </article>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-start gap-2 rounded-xl border bg-muted/40 px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted",
        entry.error && "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15",
      )}
      onClick={canExpand ? props.onToggle : undefined}
    >
      {canExpand ? (
        props.expanded ? <ChevronDown className="mt-0.5 shrink-0" /> : <ChevronRight className="mt-0.5 shrink-0" />
      ) : (
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-current opacity-60" />
      )}
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground/80">
          {entry.toolName ? humanToolLabel(entry.toolName) : entry.error ? "Voice error" : "Voice note"}
        </span>
        <span className="ml-2 text-[10px] opacity-70">{relativeTime(entry.at)}</span>
        {copy ? <span className="mt-1 block whitespace-pre-wrap break-words">{copy}</span> : null}
      </span>
    </button>
  );
}

export function VoicePanel(props: VoicePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const [textCommand, setTextCommand] = useState("");
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(() => new Set());
  const { status, statusText, micMuted, micDiagnostics, realtimeDiagnostics, entries, latestUserTranscript, assistantPreview } = useVoiceRuntimeSnapshot();
  const connected = status === "listening" || status === "speaking" || status === "muted";

  const addEntry = useCallback((role: VoiceTimelineEntry["role"], text: string, options: { toolName?: string; error?: boolean } = {}) => {
    const trimmed = text.trim();
    if ((role === "user" || role === "assistant") && !trimmed) return;
    setVoiceRuntimeSnapshot((current) => ({
      ...current,
      entries: [
        ...current.entries,
        {
          id: `voice-${Date.now()}-${current.entries.length}`,
          role,
          text: trimmed || options.toolName || "Tool call",
          toolName: options.toolName,
          error: options.error,
          at: Date.now(),
        },
      ].slice(-120),
    }));
  }, []);

  const setRuntimeStatus = useCallback((nextStatus: VoiceStatus, text?: string) => {
    setVoiceRuntimeSnapshot((current) => ({
      ...current,
      status: nextStatus,
      statusText: text ?? (
        nextStatus === "connecting" ? "Connecting to OpenAI Realtime..." :
          nextStatus === "listening" ? "Listening. Ask OpenWork to act." :
            nextStatus === "speaking" ? "OpenWork is speaking..." :
              nextStatus === "muted" ? "Connected, microphone muted." :
                nextStatus === "error" ? "Voice Mode needs attention." :
                  "Ready for voice control."
      ),
    }));
  }, []);

  const disconnectRealtime = useCallback((silent = false) => {
    try { voiceRealtime.stream?.getTracks().forEach((track) => track.stop()); } catch {}
    voiceRealtime.stream = null;
    try { voiceRealtime.channel?.close(); } catch {}
    voiceRealtime.channel = null;
    try { voiceRealtime.peer?.close(); } catch {}
    voiceRealtime.peer = null;
    try { voiceRealtime.remoteAudio?.remove(); } catch {}
    voiceRealtime.remoteAudio = null;
    voiceRealtime.assistantBuffer = "";
    voiceRealtime.responseInProgress = false;
    voiceRealtime.pendingResponse = false;
    voiceRealtime.micMuted = false;
    setVoiceRuntimeSnapshot((current) => ({
      ...current,
      micMuted: false,
      micDiagnostics: "Microphone has not started yet.",
      realtimeDiagnostics: "Realtime is not connected.",
      assistantPreview: "",
    }));
    setRuntimeStatus("idle");
    if (!silent) addEntry("system", "Voice session stopped.");
    recordInspectorEvent("voice.disconnected", { sessionId: props.sessionId });
  }, [addEntry, props.sessionId, setRuntimeStatus]);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [entries.length, assistantPreview]);

  const toggleEntryExpanded = useCallback((id: string) => {
    setExpandedEntries((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const requestRealtimeResponse = useCallback((channel: RTCDataChannel, deferIfBusy = true) => {
    if (voiceRealtime.responseInProgress) {
      if (deferIfBusy) voiceRealtime.pendingResponse = true;
      return false;
    }
    voiceRealtime.responseInProgress = true;
    channel.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"] } }));
    return true;
  }, []);

  const handleRealtimeMessage = useCallback(async (raw: string) => {
    let event: unknown = null;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const type = readString(event, "type");

    if (type === "input_audio_buffer.speech_started") {
      setRuntimeStatus("listening", "Hearing you...");
      return;
    }
    if (type === "response.created") {
      voiceRealtime.responseInProgress = true;
      voiceRealtime.pendingResponse = false;
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = readString(event, "transcript").trim();
      if (transcript && isMeaningfulTranscript(transcript)) {
        setVoiceRuntimeSnapshot((current) => ({ ...current, latestUserTranscript: transcript }));
        addEntry("user", transcript);
        recordInspectorEvent("voice.transcript", { sessionId: props.sessionId, transcript });
      }
      return;
    }
    if (type === "response.output_text.delta" || type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      const delta = readString(event, "delta");
      voiceRealtime.assistantBuffer += delta;
      setVoiceRuntimeSnapshot((current) => ({ ...current, assistantPreview: voiceRealtime.assistantBuffer.trim() }));
      setRuntimeStatus("speaking");
      return;
    }
    if (type === "response.function_call_arguments.done") {
      const toolName = readString(event, "name") || "tool";
      const callId = readString(event, "call_id");
      const args = parseJsonRecord(readString(event, "arguments"));
      addEntry("tool", toolName, { toolName });
      const output = await executeOpenWorkTool(toolName, args);
      if (isRecord(output) && output.ok === false) {
        const error = typeof output.error === "string" ? output.error : "Tool failed.";
        addEntry("tool", error, { toolName, error: true });
      }
      const channel = voiceRealtime.channel;
      if (!callId || !channel || channel.readyState !== "open") return;
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: safeJson(output) },
      }));
      requestRealtimeResponse(channel);
      return;
    }
    if (type === "response.done") {
      const text = voiceRealtime.assistantBuffer.trim();
      if (text) addEntry("assistant", text);
      voiceRealtime.assistantBuffer = "";
      setVoiceRuntimeSnapshot((current) => ({ ...current, assistantPreview: "" }));
      voiceRealtime.responseInProgress = false;
      const channel = voiceRealtime.channel;
      if (voiceRealtime.pendingResponse && channel?.readyState === "open") {
        voiceRealtime.pendingResponse = false;
        requestRealtimeResponse(channel, false);
      } else {
        setRuntimeStatus(voiceRealtime.micMuted ? "muted" : "listening");
      }
      return;
    }
    if (type === "error") {
      voiceRealtime.responseInProgress = false;
      const error = readRecord(event, "error");
      const message = typeof error.message === "string" ? error.message : "Realtime returned an error.";
      addEntry("system", message, { error: true });
      setRuntimeStatus("error", message);
    }
  }, [addEntry, props.sessionId, requestRealtimeResponse, setRuntimeStatus]);

  const connectRealtime = useCallback(async (audioInput = true) => {
    const client = props.client;
    if (!client) throw new Error("OpenWork host connection is not ready.");
    if (audioInput && !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this runtime.");

    disconnectRealtime(true);
    setRuntimeStatus("connecting", "Minting Realtime session...");
    const sessionContext = await loadVoiceSessionContext(client, props.workspaceId, props.sessionId);
    const realtimeSession = await client.createVoiceRealtimeSession({ sessionContext });

    const peer = new RTCPeerConnection();
    voiceRealtime.peer = peer;
    if (audioInput) {
      setRuntimeStatus("connecting", "Requesting microphone...");
      const macPermissionGranted = await requestMacMicrophoneAccess();
      if (!macPermissionGranted) throw new Error("macOS denied microphone access. Enable OpenWork in System Settings > Privacy & Security > Microphone, then restart OpenWork.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      voiceRealtime.stream = stream;
      setMicDiagnostics(stream);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("mute", () => setMicDiagnostics(stream));
        track.addEventListener("unmute", () => setMicDiagnostics(stream));
        track.addEventListener("ended", () => setMicDiagnostics(stream));
        peer.addTrack(track, stream);
      }
    } else {
      setVoiceRuntimeSnapshot((current) => ({ ...current, micDiagnostics: "Voice command is using typed or injected audio, not the microphone." }));
      peer.addTransceiver("audio", { direction: "recvonly" });
    }

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.style.display = "none";
    document.body.appendChild(audio);
    voiceRealtime.remoteAudio = audio;
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? null;
    };

    const channel = peer.createDataChannel("oai-events");
    voiceRealtime.channel = channel;
    channel.addEventListener("message", (event) => void handleRealtimeMessage(String(event.data)));
    channel.addEventListener("close", () => {
      if (voiceRealtime.channel === channel) setRuntimeStatus("idle");
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (!offer.sdp) throw new Error("Realtime offer did not include SDP.");

    setRuntimeStatus("connecting", "Opening voice channel...");
    const sdpResponse = await desktopFetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${realtimeSession.clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!sdpResponse.ok) {
      const detail = await sdpResponse.text().catch(() => "");
      throw new Error(`OpenAI Realtime SDP failed: ${sdpResponse.status} ${detail}`.trim());
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
    await waitForDataChannelOpen(channel);
    setRealtimeDiagnostics("Realtime data channel is open.");
    setRuntimeStatus("listening", audioInput ? undefined : "Connected. Send a typed voice command.");
    addEntry("system", `Realtime connected with ${realtimeSession.model} and ${realtimeSession.tools.length} OpenWork tools.`);
    recordInspectorEvent("voice.connected", { sessionId: props.sessionId, model: realtimeSession.model });
  }, [addEntry, disconnectRealtime, handleRealtimeMessage, props.client, props.sessionId, props.workspaceId, setRuntimeStatus]);

  const startVoice = useCallback(async () => {
    try {
      await connectRealtime(true);
      return true;
    } catch (error) {
      disconnectRealtime(true);
      const message = error instanceof Error ? error.message : String(error);
      setRealtimeDiagnostics(message);
      setRuntimeStatus("error", message);
      addEntry("system", message, { error: true });
      return { ok: false, error: message };
    }
  }, [addEntry, connectRealtime, disconnectRealtime, setRuntimeStatus]);

  const stopVoice = useCallback(() => {
    disconnectRealtime();
    return true;
  }, [disconnectRealtime]);

  const toggleMic = useCallback(() => {
    const nextMuted = !voiceRealtime.micMuted;
    voiceRealtime.micMuted = nextMuted;
    setVoiceRuntimeSnapshot((current) => ({ ...current, micMuted: nextMuted }));
    voiceRealtime.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setRuntimeStatus(nextMuted ? "muted" : "listening");
    return { muted: nextMuted };
  }, [setRuntimeStatus]);

  const sendTextCommand = useCallback(async (text: string) => {
    const value = text.trim();
    if (!value) return { ok: false, error: "Text command required." };
    if (!voiceRealtime.channel || voiceRealtime.channel.readyState !== "open") {
      try {
        await connectRealtime(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRuntimeStatus("error", message);
        addEntry("system", message, { error: true });
        return { ok: false, error: message };
      }
    }
    const channel = voiceRealtime.channel;
    if (!channel || channel.readyState !== "open") return { ok: false, error: "Realtime channel is not open." };
    addEntry("user", value);
    channel.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: value }] },
    }));
    requestRealtimeResponse(channel);
    return { ok: true, text: value };
  }, [addEntry, connectRealtime, requestRealtimeResponse, setRuntimeStatus]);

  const injectAudio = useCallback(async (args: unknown) => {
    const audio = voiceAudioArgument(args);
    if (!audio) return { ok: false, error: "pcm16Base64 audio is required." };
    if (!voiceRealtime.channel || voiceRealtime.channel.readyState !== "open") {
      const started = await startVoice();
      if (isRecord(started) && started.ok === false) return started;
    }
    const channel = voiceRealtime.channel;
    if (!channel || channel.readyState !== "open") return { ok: false, error: "Realtime channel is not open." };
    addEntry("system", "Injected deterministic audio into the Realtime input buffer.");
    channel.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    requestRealtimeResponse(channel);
    return { ok: true, bytesBase64: audio.length };
  }, [addEntry, requestRealtimeResponse, startVoice]);

  const injectTranscript = useCallback(async (args: unknown) => {
    const text = voiceTextArgument(args);
    setVoiceRuntimeSnapshot((current) => ({ ...current, latestUserTranscript: text }));
    addEntry("user", text);
    window.dispatchEvent(new CustomEvent("openwork:voice-transcript", { detail: { text } }));
    recordInspectorEvent("voice.inject_transcript", { sessionId: props.sessionId, text });
    return { ok: true, transcript: text };
  }, [addEntry, props.sessionId]);

  useEffect(() => {
    const dispose = publishInspectorSlice("voice", () => ({
      sessionId: props.sessionId,
      status,
      statusText,
      connected,
      micMuted,
      latestUserTranscript,
      assistantPreview,
      textCommandLength: textCommand.length,
      timeline: entries.slice(-12).map((entry) => ({
        role: entry.role,
        text: entry.text,
        toolName: entry.toolName,
        error: entry.error === true,
        at: entry.at,
      })),
    }));
    return dispose;
  }, [assistantPreview, connected, entries, latestUserTranscript, micDiagnostics, micMuted, props.sessionId, realtimeDiagnostics, status, statusText, textCommand.length]);

  const startAction = useMemo<OpenworkControlAction>(() => ({
    id: "voice.start",
    label: "Start Voice Mode",
    description: "Connect the Voice Mode panel to OpenAI Realtime and start listening.",
    sideEffect: "external",
    disabled: !props.client || connected || status === "connecting",
    targetRef: panelRef,
    execute: startVoice,
  }), [connected, props.client, startVoice, status]);
  useControlAction(startAction);

  const stopAction = useMemo<OpenworkControlAction>(() => ({
    id: "voice.stop",
    label: "Stop Voice Mode",
    description: "Disconnect the active Voice Mode Realtime session.",
    sideEffect: "external",
    disabled: !connected,
    targetRef: panelRef,
    execute: stopVoice,
  }), [connected, stopVoice]);
  useControlAction(stopAction);

  const muteAction = useMemo<OpenworkControlAction>(() => ({
    id: "voice.toggle_mute",
    label: micMuted ? "Unmute Voice Mode" : "Mute Voice Mode",
    description: "Toggle the microphone track without closing the Realtime session.",
    sideEffect: "none",
    disabled: !connected,
    targetRef: panelRef,
    execute: toggleMic,
  }), [connected, micMuted, toggleMic]);
  useControlAction(muteAction);

  const injectTranscriptAction = useMemo<OpenworkControlAction>(() => ({
    id: "voice.inject_transcript",
    label: "Inject a voice transcript",
    description: "Deterministic eval hook: add a transcript to Voice Mode and place it in the composer.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true, description: "Transcript text to inject." }],
    previewArgs: { text: DEFAULT_TEXT_COMMAND },
    targetRef: panelRef,
    execute: injectTranscript,
  }), [injectTranscript]);
  useControlAction(injectTranscriptAction);

  const sendTextAction = useMemo<OpenworkControlAction>(() => ({
    id: "voice.send_text",
    label: "Send text through Voice Mode",
    description: "Send a deterministic text command through the active OpenAI Realtime voice session.",
    sideEffect: "external",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true, description: "Text command to send through the Realtime model." }],
    previewArgs: { text: DEFAULT_TEXT_COMMAND },
    targetRef: panelRef,
    execute: (args) => sendTextCommand(voiceTextArgument(args)),
  }), [sendTextCommand]);
  useControlAction(sendTextAction);

  const injectAudioAction = useMemo<OpenworkControlAction>(() => ({
    id: "voice.inject_audio",
    label: "Inject voice audio",
    description: "Deterministic eval hook: send PCM16 audio through the active OpenAI Realtime input buffer.",
    sideEffect: "external",
    requiresArgs: true,
    args: [{ name: "pcm16Base64", type: "string", required: true, description: "Base64 encoded PCM16 mono audio." }],
    targetRef: panelRef,
    execute: injectAudio,
  }), [injectAudio]);
  useControlAction(injectAudioAction);

  const statusAction = useMemo<OpenworkControlAction>(() => ({
    id: "voice.status",
    label: "Read Voice Mode status",
    description: "Return the Voice Mode runtime state for tests and agents.",
    sideEffect: "none",
    execute: () => ({ status, statusText, connected, micMuted, micDiagnostics, realtimeDiagnostics, latestUserTranscript, assistantPreview }),
  }), [assistantPreview, connected, latestUserTranscript, micDiagnostics, micMuted, realtimeDiagnostics, status, statusText]);
  useControlAction(statusAction);

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span
              className={cn(
                "size-2 rounded-full bg-muted-foreground",
                status === "connecting" && "animate-pulse bg-amber-9",
                (status === "listening" || status === "speaking") && "bg-green-9",
                status === "error" && "bg-destructive",
              )}
            />
            <Radio className="text-primary" />
            Voice Mode
          </div>
          <div className="truncate text-xs text-muted-foreground">Realtime voice over OpenWork UI MCP controls</div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label="Close Voice Mode">
          <X />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ScrollAreaViewport>
          <div className="flex flex-col gap-5 px-4 py-5">
          <VoiceOrb status={status} muted={micMuted} />

          <div className="text-center">
            <div className="text-sm font-medium text-foreground">{statusText}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Say things like "type a follow-up", "send it", or "read the latest session message".
            </div>
          </div>

          {entries.length === 0 && !assistantPreview ? (
            <div className="flex flex-wrap justify-center gap-1.5">
              {VOICE_SUGGESTIONS.map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  size="xs"
                  className="rounded-full"
                  onClick={() => setTextCommand(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => void startVoice()} disabled={!props.client || connected || status === "connecting"}>
              {status === "connecting" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Mic2 data-icon="inline-start" />}
              Start voice
            </Button>
            <Button variant="outline" onClick={stopVoice} disabled={!connected}>
              <Square data-icon="inline-start" />
              Stop
            </Button>
            <Button variant="outline" onClick={toggleMic} disabled={!connected} className="col-span-2">
              {micMuted ? <Mic2 data-icon="inline-start" /> : <MicOff data-icon="inline-start" />}
              {micMuted ? "Unmute microphone" : "Mute microphone"}
            </Button>
          </div>

          {!props.client ? (
            <Card variant="outline" size="sm">
              <CardHeader>
                <CardTitle>Host connection required</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Voice Mode needs the local OpenWork server so it can mint short-lived Realtime client secrets without exposing your API key to the renderer.
              </CardContent>
            </Card>
          ) : null}

          {assistantPreview ? (
            <Card variant="outline" size="sm" className="overflow-hidden">
              <CardContent className="relative p-0">
                <div className="absolute inset-x-0 top-0 h-1 overflow-hidden">
                  <PaperGrainGradient
                    speed={16}
                    softness={0.14}
                    intensity={1}
                    noise={0.05}
                    shape="wave"
                    colors={["#818cf8", "#fb7185", "#fbbf24", "#34d399"]}
                    colorBack="#ffffff00"
                    style={{ width: "100%", height: "100%" }}
                  />
                </div>
                <div className="flex flex-col gap-2 px-3 pb-3 pt-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Rendering response</div>
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-card-foreground" aria-live="polite">
                    {assistantPreview}
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card variant="outline" size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Radio className="text-primary" />
                Voice diagnostics
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">Connection:</span> {realtimeDiagnostics}
              </div>
              <div>
                <span className="font-medium text-foreground">Microphone:</span> {micDiagnostics}
              </div>
              {status === "error" ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">
                  {statusText}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card variant="outline" size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="text-primary" />
                Typed voice command
              </CardTitle>
            </CardHeader>
            <CardContent>
              <InputGroup>
                <InputGroupTextarea
                  value={textCommand}
                  onChange={(event) => setTextCommand(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey) return;
                    event.preventDefault();
                    const text = textCommand;
                    setTextCommand("");
                    void sendTextCommand(text);
                  }}
                  placeholder={DEFAULT_TEXT_COMMAND}
                  rows={3}
                />
                <InputGroupAddon align="block-end" className="justify-between border-t border-border">
                  <span className="text-xs text-muted-foreground">Enter to send, Shift+Enter for newline</span>
                  <InputGroupButton
                    variant="outline"
                    onClick={() => {
                      const text = textCommand;
                      setTextCommand("");
                      void sendTextCommand(text);
                    }}
                    disabled={!textCommand.trim() || status === "connecting"}
                  >
                    <SendHorizontal data-icon="inline-start" />
                    Send
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium uppercase tracking-[0.15em] text-muted-foreground">Timeline</div>
            {entries.length ? entries.map((entry) => (
              <VoiceTimelineRow
                key={entry.id}
                entry={entry}
                expanded={expandedEntries.has(entry.id)}
                onToggle={() => toggleEntryExpanded(entry.id)}
              />
            )) : (
              <div className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                Start voice or inject a transcript from UI MCP to see the voice timeline.
              </div>
            )}
            <div ref={timelineEndRef} />
          </div>
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </div>
  );
}
