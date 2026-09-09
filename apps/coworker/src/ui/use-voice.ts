import { createContext, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { coworkerBridge } from "@/lib/bridge";
import { rebindVoiceExpectation, recordingType, voiceError, voicePackets, VOICE_MAX_BYTES, VOICE_MAX_SECONDS, type VoiceExpectation, type VoiceReply } from "@/lib/voice";

export const VoiceContext = createContext<{ accountKey: string; openModels: () => void; signIn: () => void } | null>(null);
type Access = Awaited<ReturnType<typeof coworkerBridge.voice.status>>["access"];
type Phase = "idle" | "checking" | "permission" | "recording" | "transcribing" | "preparing" | "speaking";
export type VoicePreparation = { accountKey: string; origin: HTMLElement | null; field: HTMLTextAreaElement | null; isCurrent: () => boolean };
export type VoiceActivation = { accountKey: string; scope: string; focus: { origin: HTMLElement; target: "panel" | "draft"; start: number; end: number } | null };

/** One composer owns all media. Nothing here sends a turn or changes an answer model. */
export function useVoice({ active, scope, onTranscript, reply = null, endedTurn = null, onReady, activation, onActivationHandled }: {
  active: boolean; scope: string; onTranscript: (text: string) => void; reply?: VoiceReply | null; endedTurn?: string | null;
  onReady?: (request: VoicePreparation) => Promise<void>;
  activation?: VoiceActivation;
  onActivationHandled?: () => void;
}) {
  const account = useContext(VoiceContext);
  if (!account) throw new Error("Voice requires the app account context");
  const accountKey = account.accountKey;
  const identity = `${accountKey}\0${scope}`;
  const live = useRef({ active, identity, onTranscript, onReady });
  live.current = { active, identity, onTranscript, onReady };
  const [enabled, setEnabled] = useState(false);
  const enabledRef = useRef(false);
  const [access, setAccess] = useState<Access | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const [status, setStatus] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [caption, setCaption] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [expectedTurn, setExpectedTurn] = useState<VoiceExpectation | null>(null);
  const expectedRef = useRef<VoiceExpectation | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusOrigin = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const operationIdentity = useRef(identity);
  const heldSpace = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const ended = useRef<(() => void) | null>(null);
  const meterTimer = useRef<number | undefined>(undefined);
  const limitTimer = useRef<number | undefined>(undefined);
  const requestId = useRef<string | null>(null);
  const abortRequest = useRef<(() => void) | null>(null);
  const pendingRequest = useRef<Promise<void>>(Promise.resolve());

  const setStage = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);
  const releaseRecording = useCallback(() => {
    window.clearInterval(meterTimer.current);
    window.clearTimeout(limitTimer.current);
    meterTimer.current = undefined;
    limitTimer.current = undefined;
    const current = recorder.current;
    recorder.current = null;
    if (current) {
      current.ondataavailable = null; current.onstop = null; current.onerror = null;
      if (current.state !== "inactive") current.stop();
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);
  const dispose = useCallback(() => {
    generation.current += 1;
    focusOrigin.current = null;
    heldSpace.current = false;
    releaseRecording();
    abortRequest.current?.();
    abortRequest.current = null;
    if (requestId.current) void coworkerBridge.voice.cancel(requestId.current).catch(() => undefined);
    requestId.current = null;
    if (source.current) { source.current.onended = null; source.current.stop(); source.current.disconnect(); source.current = null; }
    ended.current?.(); ended.current = null;
    if (audio.current) void audio.current.close().catch(() => undefined);
    audio.current = null;
  }, [releaseRecording]);

  function current(ticket: number): boolean {
    return mounted.current && generation.current === ticket && live.current.identity === operationIdentity.current && live.current.active && document.visibilityState !== "hidden" && document.hasFocus();
  }
  function focusDraft() { if (live.current.active && document.hasFocus()) fieldRef.current?.focus({ preventScroll: true }); }
  function stop(note = "Voice stopped. Your text conversation continues.", focus = false) {
    const relevant = enabledRef.current || phaseRef.current !== "idle";
    dispose(); expectedRef.current = null; setExpectedTurn(null); setStage("idle"); setCaption(""); setLevels([]); setTruncated(false); setStatus(relevant ? note : "");
    if (focus) focusDraft();
  }
  function fail(cause: unknown, focus = true) {
    stop(voiceError(cause), focus);
    const message = String(cause);
    if (/voice_(membership_required|sign_in|unauthorized)/.test(message)) {
      enabledRef.current = false; setEnabled(false);
      setAccess(/membership_required/.test(message) ? "membership_required" : "sign_in");
    }
  }

  useLayoutEffect(() => {
    mounted.current = true;
    enabledRef.current = false; setEnabled(false); setAccess(null); setStage("idle");
    expectedRef.current = null; setExpectedTurn(null); setStatus(""); setCaption(""); setLevels([]); setTruncated(false);
    operationIdentity.current = identity;
    return () => { mounted.current = false; enabledRef.current = false; dispose(); };
  }, [identity, active, dispose, setStage]);
  useLayoutEffect(() => {
    const origin = focusOrigin.current;
    focusOrigin.current = null;
    if (enabled && origin && document.activeElement === origin) panelRef.current?.focus({ preventScroll: true });
  }, [enabled]);

  async function toggle(origin: HTMLElement | null = null) {
    if (enabledRef.current || phaseRef.current === "checking") {
      stop("Voice mode off."); enabledRef.current = false; setEnabled(false); setAccess(null); return;
    }
    if (!live.current.active) return;
    dispose(); operationIdentity.current = live.current.identity;
    const ticket = generation.current;
    const opener = document.activeElement === origin ? origin : null;
    setStage("checking"); setStatus("Checking voice access..."); setAccess(null);
    try {
      const result = await coworkerBridge.voice.status();
      if (!current(ticket)) return;
      setAccess(result.access);
      if (result.access === "ready") {
        if (live.current.onReady) {
          setStatus("Preparing your discussion...");
          await live.current.onReady({ accountKey, origin: document.activeElement === opener ? opener : null, field: fieldRef.current, isCurrent: () => current(ticket) });
          return;
        }
        focusOrigin.current = opener;
        enabledRef.current = true; setEnabled(true);
        setStatus("Voice ready. Record a message, then review and send.");
      } else setStatus(result.access === "unavailable" ? "Voice is unavailable right now. This does not mean you need a subscription." : "");
      setStage("idle");
    } catch (cause) { if (current(ticket)) { setAccess("unavailable"); fail(cause, false); } }
  }

  const activatePrepared = useEffectEvent((request: VoiceActivation) => {
    if (request.accountKey !== accountKey || request.scope !== scope || !active) { onActivationHandled?.(); return; }
    const focus = request.focus;
    let opener: HTMLElement | null = null;
    // Transfer focus only from the control removed by this intentional handoff.
    if (focus && !focus.origin.isConnected && (document.activeElement === document.body || (focus.target === "panel" && document.activeElement === toggleRef.current))) {
      if (focus.target === "draft") {
        fieldRef.current?.focus({ preventScroll: true });
        fieldRef.current?.setSelectionRange(focus.start, focus.end);
      } else {
        toggleRef.current?.focus({ preventScroll: true });
        opener = toggleRef.current;
      }
    }
    // Recheck access in the real thread; the transferred value is intent, not permission.
    void toggle(opener);
    onActivationHandled?.();
  });
  useEffect(() => { if (activation) activatePrepared(activation); }, [activation]);

  async function request<T>(ticket: number, run: (id: string) => Promise<T>): Promise<T> {
    // A dispatched packet may finish solely to settle usage; never regenerate it.
    await pendingRequest.current;
    if (!current(ticket)) throw new Error("voice_cancelled");
    const id = crypto.randomUUID();
    requestId.current = id;
    const result = run(id);
    pendingRequest.current = result.then(() => undefined, () => undefined);
    let timer: number | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abortRequest.current = () => reject(new Error("voice_cancelled"));
      timer = window.setTimeout(() => {
        void coworkerBridge.voice.cancel(id).catch(() => undefined);
        reject(new Error("voice_timeout"));
      }, 60_000);
    });
    try { return await Promise.race([result, cancelled]); }
    finally {
      window.clearTimeout(timer);
      if (requestId.current === id) { requestId.current = null; abortRequest.current = null; }
    }
  }

  function finishRecording() {
    if (phaseRef.current === "permission") { stop("Recording cancelled. Your draft is kept.", true); return; }
    const recording = recorder.current;
    if (!recording || recording.state === "inactive") return;
    heldSpace.current = false;
    setStage("transcribing"); setStatus("Turning your recording into an editable draft...");
    window.clearInterval(meterTimer.current); window.clearTimeout(limitTimer.current);
    recording.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (audio.current) void audio.current.close().catch(() => undefined);
    audio.current = null;
  }

  function startRecording() {
    if (!enabledRef.current || !live.current.active || document.visibilityState === "hidden" || !document.hasFocus()) return;
    if (["permission", "recording", "transcribing"].includes(phaseRef.current)) return;
    // Keep this call on the click/keydown stack, before any unrelated await.
    const permission = coworkerBridge.voice.microphone();
    const wasHeld = heldSpace.current;
    stop(""); heldSpace.current = wasHeld;
    operationIdentity.current = live.current.identity;
    const ticket = generation.current;
    setStage("permission"); setStatus("Waiting for microphone permission..."); setElapsed(0); setTruncated(false);
    void (async () => {
      try {
        const allowed = await permission;
        if (!current(ticket)) return;
        if (!allowed.granted) throw new Error("voice_microphone_denied");
        const type = typeof MediaRecorder === "undefined" ? null : recordingType((mime) => MediaRecorder.isTypeSupported(mime));
        if (!type) throw new Error("voice_recording_unavailable");
        const captured = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (!current(ticket)) { captured.getTracks().forEach((track) => track.stop()); return; }
        stream.current = captured;
        const recording = new MediaRecorder(captured, { mimeType: type.mimeType, audioBitsPerSecond: 64_000 });
        recorder.current = recording;
        const context = new AudioContext(); audio.current = context;
        await context.resume();
        if (!current(ticket)) { captured.getTracks().forEach((track) => track.stop()); void context.close().catch(() => undefined); return; }
        const analyser = context.createAnalyser(); analyser.fftSize = 256;
        context.createMediaStreamSource(captured).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const chunks: Blob[] = [];
        let bytes = 0;
        const started = performance.now();
        recording.ondataavailable = (event) => {
          if (!current(ticket) || !event.data.size) return;
          bytes += event.data.size;
          if (bytes > VOICE_MAX_BYTES) { stop("Recording reached 3 MiB and was discarded. Try a shorter message.", true); return; }
          chunks.push(event.data);
        };
        recording.onerror = () => { if (current(ticket)) fail(new Error("voice_recording_failed")); };
        recording.onstop = () => {
          if (!current(ticket)) return;
          releaseRecording();
          if (audio.current) void audio.current.close().catch(() => undefined);
          audio.current = null;
          setStage("transcribing"); setStatus("Turning your recording into an editable draft...");
          void (async () => {
            try {
              const blob = new Blob(chunks, { type: recording.mimeType });
              if (!blob.size) { stop("No audio was captured. Try again.", true); return; }
              const buffer = new Uint8Array(await blob.arrayBuffer());
              if (!current(ticket)) return;
              let binary = "";
              for (let offset = 0; offset < buffer.length; offset += 8192) binary += String.fromCharCode(...buffer.subarray(offset, offset + 8192));
              const result = await request(ticket, (id) => coworkerBridge.voice.transcribe({ requestId: id, data: btoa(binary), format: type.format }));
              if (!current(ticket)) return;
              if (result.text.trim()) live.current.onTranscript(result.text);
              stop(result.text.trim() ? "Added to your draft. Review it, then press Send." : "No words were found. Try again or keep typing.", true);
            } catch (cause) { if (current(ticket)) fail(cause); }
          })();
        };
        recording.start(200);
        setStage("recording"); setStatus("Recording. Finish to review, or Escape to discard.");
        meterTimer.current = window.setInterval(() => {
          if (!current(ticket)) return;
          analyser.getByteTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
          setLevels((history) => [...history.slice(-23), Math.min(1, rms * 5)]);
          setElapsed(Math.min(VOICE_MAX_SECONDS, Math.floor((performance.now() - started) / 1000)));
        }, 100);
        limitTimer.current = window.setTimeout(finishRecording, VOICE_MAX_SECONDS * 1000);
      } catch (cause) { if (current(ticket)) fail(cause); }
    })();
  }

  function expectReply(turnId: string | null): VoiceExpectation | null {
    stop("");
    if (!enabledRef.current || !live.current.active || !document.hasFocus() || document.visibilityState === "hidden") return null;
    if (!turnId) { setStatus("Queued replies stay in the transcript. You can keep dictating here."); return null; }
    operationIdentity.current = live.current.identity;
    try {
      // Unlock playback on the person's Send gesture, not when a late reply arrives.
      const context = new AudioContext(); audio.current = context;
      void context.resume().catch(() => { if (audio.current === context) fail(new Error("voice_playback_unavailable")); });
      const expected = { turnId, generation: generation.current, admitted: false };
      expectedRef.current = expected; setExpectedTurn(expected); setStatus("New replies will be read aloud. You can keep typing.");
      return expected;
    } catch (cause) { fail(cause); return null; }
  }
  function rebindExpected(requested: VoiceExpectation | null, acceptedId: string): VoiceExpectation | null {
    if (!enabledRef.current || !current(generation.current)) return null;
    const rebound = rebindVoiceExpectation(expectedRef.current, requested, acceptedId, generation.current);
    if (rebound) { expectedRef.current = rebound; setExpectedTurn(rebound); }
    return rebound;
  }
  function abandonReply(requested: VoiceExpectation | null) {
    if (requested && rebindVoiceExpectation(expectedRef.current, requested, requested.turnId, generation.current)) stop("No spoken reply. Any results remain in the transcript.");
  }

  const speak = useEffectEvent(async (next: VoiceReply) => {
    if (!enabledRef.current || !current(generation.current) || !audio.current || !expectedRef.current?.admitted || expectedRef.current.turnId !== next.turnId) return;
    const ticket = generation.current;
    const context = audio.current;
    expectedRef.current = null; setExpectedTurn(null);
    const { packets, truncated: clipped } = voicePackets(next.text);
    setTruncated(clipped); setStatus("Reading the reply aloud. Stop audio leaves the text conversation unchanged.");
    try {
      for (const packet of packets) {
        if (!current(ticket)) return;
        setStage("preparing");
        const result = await request(ticket, (id) => coworkerBridge.voice.speech({ requestId: id, text: packet }));
        if (!current(ticket)) return;
        if (result.mimeType !== "audio/mpeg" || result.data.length > 8 * 1024 * 1024) throw new Error("voice_audio_invalid");
        const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
        const decoded = await context.decodeAudioData(bytes.buffer);
        if (!current(ticket)) return;
        if (!decoded.duration || decoded.duration > 90) throw new Error("voice_audio_invalid");
        const playback = context.createBufferSource(); source.current = playback;
        playback.buffer = decoded; playback.connect(context.destination);
        setCaption(packet); setStage("speaking");
        await new Promise<void>((resolve) => {
          ended.current = resolve;
          playback.onended = () => resolve();
          playback.start();
        });
        playback.disconnect();
        if (!current(ticket)) return;
        source.current = null; ended.current = null;
      }
      if (current(ticket)) { dispose(); setStage("idle"); setStatus(clipped ? "Spoken preview finished. Read the rest in the transcript." : "Spoken reply finished."); }
    } catch (cause) { if (current(ticket)) fail(cause); }
  });
  useEffect(() => {
    if (enabled && expectedTurn?.admitted && reply?.turnId === expectedTurn.turnId) void speak(reply);
  }, [enabled, expectedTurn, reply?.id, reply?.turnId, reply?.text]);
  const settleSilent = useEffectEvent(() => stop("No spoken reply. Any results remain in the transcript."));
  useEffect(() => {
    if (expectedTurn?.admitted && expectedRef.current === expectedTurn && endedTurn === expectedTurn.turnId && reply?.turnId !== expectedTurn.turnId) settleSilent();
  }, [expectedTurn, endedTurn, reply?.turnId]);

  const suspend = useEffectEvent(() => {
    if (enabledRef.current || phaseRef.current !== "idle") stop("Voice paused. Record or send a new message when you return.");
  });
  const keydown = useEffectEvent((event: KeyboardEvent) => {
    if (!enabledRef.current || !live.current.active || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape" && (phaseRef.current !== "idle" || expectedRef.current)) { event.preventDefault(); stop("Voice cancelled. Your draft is kept.", true); return; }
    if (event.code === "Space" && heldSpace.current) { event.preventDefault(); return; }
    if (event.code !== "Space" || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!panelRef.current || event.target !== panelRef.current || document.activeElement !== panelRef.current) return;
    if ([...document.querySelectorAll("[role='dialog'], [aria-modal='true'], dialog[open]")].some((element) => element.getClientRects().length > 0)) return;
    if (["permission", "recording", "transcribing"].includes(phaseRef.current)) return;
    event.preventDefault(); heldSpace.current = true; startRecording();
  });
  const keyup = useEffectEvent((event: KeyboardEvent) => {
    if (event.code === "Space" && heldSpace.current) { event.preventDefault(); heldSpace.current = false; finishRecording(); }
  });
  useEffect(() => {
    const visibility = () => { if (document.visibilityState === "hidden") suspend(); };
    window.addEventListener("blur", suspend);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    return () => {
      window.removeEventListener("blur", suspend); document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup);
    };
  }, []);

  return { enabled, access, phase, status, elapsed, levels, caption, truncated, panelRef, fieldRef, toggleRef, toggle, startRecording, finishRecording, stop, expectReply, rebindExpected, abandonReply, openModels: account.openModels, signIn: account.signIn };
}

export type VoiceController = ReturnType<typeof useVoice>;
