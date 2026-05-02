import type { OpenworkRemoteSession } from "../../app/lib/openwork-server";
import type { OpenworkControlResult, OpenworkControlSnapshot } from "./control-mode";

type RemoteEvent = {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  delta?: string;
  transcript?: string;
  response?: unknown;
};

export type RealtimeControlState = {
  status: "idle" | "connecting" | "connected" | "error";
  mic: "off" | "requesting" | "on" | "error";
  micPermission: string | null;
  micTrack: string | null;
  micLabel: string | null;
  lastError: string | null;
  lastTranscript: string;
  lastText: string;
  lastEventType: string | null;
  transcriptLog: RealtimeTranscriptEntry[];
};

export type RealtimeTranscriptEntry = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  status?: "pending" | "done" | "error";
  createdAt: number;
};

export type RealtimeControlController = {
  connect: (input: { createSession: () => Promise<OpenworkRemoteSession>; audioInput?: boolean; audioDeviceId?: string; audioDeviceLabel?: string }) => Promise<RealtimeControlState>;
  disconnect: () => void;
  sendText: (text: string) => void;
  state: () => RealtimeControlState;
  subscribe: (listener: (state: RealtimeControlState) => void) => () => void;
};

type RealtimeRoot = typeof window & {
  __openworkRealtimeControl?: RealtimeControlController;
  __OPENWORK_ELECTRON__?: {
    permissions?: {
      requestMicrophone?: () => Promise<{ granted: boolean; status: string }>;
    };
  };
};

const state: RealtimeControlState = {
  status: "idle",
  mic: "off",
  micPermission: null,
  micTrack: null,
  micLabel: null,
  lastError: null,
  lastTranscript: "",
  lastText: "",
  lastEventType: null,
  transcriptLog: [],
};

let peer: RTCPeerConnection | null = null;
let dataChannel: RTCDataChannel | null = null;
let remoteAudio: HTMLAudioElement | null = null;
let localAudioStream: MediaStream | null = null;
const stateListeners = new Set<(state: RealtimeControlState) => void>();
let nextLogId = 1;
let activeAssistantLogId: string | null = null;

function setState(update: Partial<RealtimeControlState>) {
  Object.assign(state, update);
  const next = { ...state };
  stateListeners.forEach((listener) => listener(next));
}

function appendTranscriptLog(entry: Omit<RealtimeTranscriptEntry, "id" | "createdAt">) {
  const item: RealtimeTranscriptEntry = {
    ...entry,
    id: `rt-${nextLogId++}`,
    createdAt: Date.now(),
  };
  setState({ transcriptLog: [...state.transcriptLog, item].slice(-40) });
  return item.id;
}

function updateTranscriptLog(id: string, update: Partial<Omit<RealtimeTranscriptEntry, "id" | "createdAt">>) {
  setState({
    transcriptLog: state.transcriptLog.map((entry) => (
      entry.id === id ? { ...entry, ...update } : entry
    )),
  });
}

function ensureControlSurface() {
  const control = window.__openworkControl;
  if (!control) throw new Error("OpenWork control surface is not available");
  return control;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ ok: false, error: "Could not serialize result" });
  }
}

function parseArguments(raw: string | undefined) {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function requestHostMicrophonePermission() {
  const root = window as RealtimeRoot;
  const requestMicrophone = root.__OPENWORK_ELECTRON__?.permissions?.requestMicrophone;
  if (!requestMicrophone) {
    setState({ micPermission: "browser" });
    return;
  }
  const result = await requestMicrophone();
  setState({ micPermission: result?.status ?? "unknown" });
  if (result && result.granted === false) {
    throw new Error(`Microphone permission is ${result.status || "not granted"}. Enable it in macOS Privacy & Security settings.`);
  }
}

async function getMicrophoneStream(deviceId: string) {
  const constraints: MediaStreamConstraints = {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (!deviceId || !(error instanceof DOMException) || error.name !== "OverconstrainedError") {
      throw error;
    }
    appendTranscriptLog({ role: "system", text: "Selected microphone is unavailable; falling back to system default.", status: "done" });
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }
}

function errorMessage(error: unknown) {
  if (error instanceof DOMException) {
    const message = error.message.trim();
    const constraint = "constraint" in error && typeof error.constraint === "string" && error.constraint.trim()
      ? ` (${error.constraint})`
      : "";
    return message || `${error.name}${constraint}`;
  }
  if (error instanceof Error) return error.message || error.name || String(error);
  return String(error);
}

function waitForDataChannelOpen(channel: RTCDataChannel) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanupListeners();
      reject(new Error("Realtime data channel did not open in time"));
    }, 10000);
    const cleanupListeners = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
    };
    const handleOpen = () => {
      cleanupListeners();
      resolve();
    };
    const handleClose = () => {
      cleanupListeners();
      reject(new Error("Realtime data channel closed before it opened"));
    };
    const handleError = () => {
      cleanupListeners();
      reject(new Error("Realtime data channel failed to open"));
    };
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

async function handleToolCall(event: RemoteEvent) {
  const control = ensureControlSurface();
  const args = parseArguments(event.arguments);
  const toolLabel = event.name === "execute_action"
    ? `execute_action ${typeof args.actionId === "string" ? args.actionId : ""}`.trim()
    : event.name === "set_input"
      ? `set_input ${typeof args.actionId === "string" ? args.actionId : ""}`.trim()
      : event.name ?? "unknown_tool";
  const toolLogId = appendTranscriptLog({ role: "tool", text: `Calling ${toolLabel}…`, status: "pending" });
  let output: OpenworkControlSnapshot | OpenworkControlSnapshot["actions"] | OpenworkControlResult | { ok: false; error: string };

  if (event.name === "snapshot") {
    output = control.snapshot();
  } else if (event.name === "list_actions") {
    output = control.listActions();
  } else if (event.name === "execute_action") {
    const actionId = typeof args.actionId === "string" ? args.actionId : "";
    output = actionId
      ? await control.execute(actionId, args.args)
      : { ok: false, error: "execute_action requires actionId" };
  } else if (event.name === "set_input") {
    const actionId = typeof args.actionId === "string" ? args.actionId : "";
    const text = typeof args.text === "string" ? args.text : "";
    output = actionId
      ? await control.execute(actionId, { text })
      : { ok: false, error: "set_input requires actionId" };
  } else if (event.name === "list_sessions") {
    output = await control.execute("session.list_sessions");
  } else if (event.name === "open_session") {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    output = sessionId
      ? await control.execute("session.open", { sessionId })
      : { ok: false, error: "open_session requires sessionId" };
  } else if (event.name === "rename_session") {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    const title = typeof args.title === "string" ? args.title : "";
    output = sessionId && title
      ? await control.execute("session.rename", { sessionId, title })
      : { ok: false, error: "rename_session requires sessionId and title" };
  } else if (event.name === "delete_session") {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
    output = sessionId
      ? await control.execute("session.delete", { sessionId, confirmed: args.confirmed === true })
      : { ok: false, error: "delete_session requires sessionId" };
  } else if (event.name === "scroll_session") {
    const position = args.position === "top" ? "top" : "bottom";
    output = await control.execute(position === "top" ? "session.scroll_top" : "session.scroll_bottom");
  } else if (event.name === "get_latest_message") {
    output = await control.execute("session.latest_message");
  } else {
    output = { ok: false, error: `Unknown tool: ${event.name ?? "unknown"}` };
  }

  const failed = typeof output === "object" && output !== null && "ok" in output && output.ok === false;
  updateTranscriptLog(toolLogId, {
    text: failed
      ? `Tool failed: ${toolLabel}${"error" in output ? ` — ${String(output.error)}` : ""}`
      : `Tool complete: ${toolLabel}`,
    status: failed ? "error" : "done",
  });

  if (!event.call_id || !dataChannel || dataChannel.readyState !== "open") return;
  dataChannel.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: event.call_id,
      output: safeJson(output),
    },
  }));
  dataChannel.send(JSON.stringify({
    type: "response.create",
    response: { output_modalities: ["text"] },
  }));
}

async function handleRealtimeMessage(raw: string) {
  let event: RemoteEvent;
  try {
    event = JSON.parse(raw) as RemoteEvent;
  } catch {
    return;
  }
  setState({ lastEventType: event.type ?? null });

  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    const nextText = `${state.lastText}${event.delta}`;
    if (!activeAssistantLogId) {
      activeAssistantLogId = appendTranscriptLog({ role: "assistant", text: event.delta, status: "pending" });
    } else {
      updateTranscriptLog(activeAssistantLogId, { text: nextText, status: "pending" });
    }
    setState({ lastText: nextText });
    return;
  }

  if (event.type === "response.done" && activeAssistantLogId) {
    updateTranscriptLog(activeAssistantLogId, { status: "done" });
    activeAssistantLogId = null;
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
    setState({ lastTranscript: `${state.lastTranscript}${event.delta}` });
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
    setState({ lastTranscript: event.transcript });
    appendTranscriptLog({ role: "user", text: event.transcript, status: "done" });
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    await handleToolCall(event);
  }
}

function cleanup() {
  localAudioStream?.getTracks().forEach((track) => track.stop());
  localAudioStream = null;
  setState({ micTrack: null });
  activeAssistantLogId = null;
  dataChannel?.close();
  dataChannel = null;
  peer?.close();
  peer = null;
  remoteAudio?.remove();
  remoteAudio = null;
}

export function getRealtimeControlController(): RealtimeControlController {
  const root = window as RealtimeRoot;
  if (root.__openworkRealtimeControl) return root.__openworkRealtimeControl;

  const controller: RealtimeControlController = {
    async connect(input) {
      cleanup();
      setState({ status: "connecting", mic: "off", micPermission: null, micTrack: null, micLabel: input.audioDeviceLabel?.trim() || "System default", lastError: null, lastTranscript: "", lastText: "", lastEventType: null, transcriptLog: [] });
      const startupLogId = appendTranscriptLog({ role: "system", text: "Starting voice control…", status: "pending" });
      try {
        const audioInput = input.audioInput !== false;
        if (audioInput) {
          if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone capture is not available in this browser context");
          }
          setState({ mic: "requesting" });
          await requestHostMicrophonePermission();
          const deviceId = input.audioDeviceId?.trim() ?? "";
          localAudioStream = await getMicrophoneStream(deviceId);
          const audioTrack = localAudioStream.getAudioTracks()[0];
          if (!audioTrack) {
            throw new Error("No microphone audio track was returned");
          }
          setState({ mic: "on", micLabel: audioTrack.label || input.audioDeviceLabel || "System default", micTrack: `${audioTrack.readyState}:${audioTrack.enabled ? "enabled" : "disabled"}` });
          appendTranscriptLog({ role: "system", text: `Microphone live: ${audioTrack.label || input.audioDeviceLabel || "System default"}`, status: "done" });
          audioTrack.addEventListener("ended", () => {
            setState({ mic: "off", micTrack: "ended" });
          });
        }

        const session = await input.createSession();
        const pc = new RTCPeerConnection();
        peer = pc;

        remoteAudio = document.createElement("audio");
        remoteAudio.autoplay = true;
        remoteAudio.dataset.openworkRealtime = "true";
        remoteAudio.style.display = "none";
        document.body.appendChild(remoteAudio);
        if (audioInput) {
          const audioTrack = localAudioStream?.getAudioTracks()[0];
          if (!audioTrack) {
            throw new Error("No microphone audio track is available");
          }
          pc.addTrack(audioTrack, localAudioStream ?? new MediaStream([audioTrack]));
        } else {
          pc.addTransceiver("audio", { direction: "recvonly" });
        }
        pc.ontrack = (event) => {
          if (remoteAudio) remoteAudio.srcObject = event.streams[0] ?? null;
        };

        const channel = pc.createDataChannel("oai-events");
        dataChannel = channel;
        channel.addEventListener("message", (event) => {
          void handleRealtimeMessage(String(event.data));
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        });
        if (!sdpResponse.ok) {
          const detail = await sdpResponse.text().catch(() => "");
          throw new Error(`OpenAI Realtime SDP failed: ${sdpResponse.status}${detail ? ` ${detail}` : ""}`);
        }
        await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
        await waitForDataChannelOpen(channel);
        const liveTrack = localAudioStream?.getAudioTracks()[0];
        setState({
          status: "connected",
          mic: liveTrack && liveTrack.readyState === "live" ? "on" : state.mic,
          micLabel: liveTrack?.label || state.micLabel,
          micTrack: liveTrack ? `${liveTrack.readyState}:${liveTrack.enabled ? "enabled" : "disabled"}` : state.micTrack,
          lastError: null,
        });
        updateTranscriptLog(startupLogId, { text: "Voice control connected", status: "done" });
        window.__openworkControl?.setEnabled(true);
        return { ...state };
      } catch (error) {
      cleanup();
      const message = errorMessage(error);
      appendTranscriptLog({ role: "system", text: message, status: "error" });
      setState({ status: "error", mic: "error", lastError: message });
      return { ...state };
      }
    },
    disconnect() {
      cleanup();
      setState({ status: "idle", mic: "off", micTrack: null, lastError: null, lastEventType: null });
    },
    sendText(text) {
      if (!dataChannel || dataChannel.readyState !== "open") {
        throw new Error("Realtime data channel is not connected");
      }
      setState({ lastTranscript: text, lastText: "" });
      appendTranscriptLog({ role: "user", text, status: "done" });
      dataChannel.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      }));
      dataChannel.send(JSON.stringify({
        type: "response.create",
        response: { output_modalities: ["text"] },
      }));
    },
    state() {
      return { ...state };
    },
    subscribe(listener) {
      stateListeners.add(listener);
      listener({ ...state });
      return () => {
        stateListeners.delete(listener);
      };
    },
  };

  root.__openworkRealtimeControl = controller;
  return controller;
}

if (typeof window !== "undefined") {
  getRealtimeControlController();
}
