/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

type DictationPhase = "idle" | "preparing" | "recording" | "transcribing";

type LocalDictationButtonProps = {
  draft: string;
  disabled: boolean;
  onDraftChange: (value: string) => void;
};

const MAX_RECORDING_DURATION_MS = 60_000;
const PREFERRED_AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function preferredAudioType() {
  return PREFERRED_AUDIO_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

export function LocalDictationButton(props: LocalDictationButtonProps) {
  const [phase, setPhaseState] = useState<DictationPhase>("idle");
  const mountedRef = useRef(true);
  const phaseRef = useRef<DictationPhase>("idle");
  const draftRef = useRef(props.draft);
  const onDraftChangeRef = useRef(props.onDraftChange);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  draftRef.current = props.draft;
  onDraftChangeRef.current = props.onDraftChange;

  const bridge = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__?.system;
  const available = Boolean(bridge?.getLocalSpeechStatus && bridge.transcribeLocalAudio);

  const setPhase = (nextPhase: DictationPhase) => {
    phaseRef.current = nextPhase;
    if (mountedRef.current) setPhaseState(nextPhase);
  };

  const clearRecordingTimeout = () => {
    if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    recordingTimeoutRef.current = null;
  };

  const releaseMicrophone = () => {
    clearRecordingTimeout();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRecordingTimeout();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      chunksRef.current = [];
    };
  }, []);

  if (!available) return null;

  const transcribeRecording = async (mimeType: string) => {
    const recording = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    releaseMicrophone();
    if (!mountedRef.current) return;
    if (!recording.size) {
      setPhase("idle");
      toast.error(t("composer.local_voice_empty"));
      return;
    }

    setPhase("transcribing");
    try {
      const audio = new Uint8Array(await recording.arrayBuffer());
      const result = await bridge?.transcribeLocalAudio?.({ audio, mimeType });
      if (!mountedRef.current) return;
      const transcript = result?.text.trim() ?? "";
      if (!transcript) {
        toast.error(t("composer.local_voice_empty"));
        return;
      }
      const currentDraft = draftRef.current;
      const separator = currentDraft && !/\s$/.test(currentDraft) ? " " : "";
      onDraftChangeRef.current(`${currentDraft}${separator}${transcript}`);
      requestAnimationFrame(() => window.dispatchEvent(new Event("openwork:focusPrompt")));
    } catch (error) {
      if (mountedRef.current) {
        toast.error(t("composer.local_voice_failed"), { description: describeError(error) });
      }
    } finally {
      if (mountedRef.current) setPhase("idle");
    }
  };

  const startRecording = async () => {
    try {
      const speechStatus = await bridge?.getLocalSpeechStatus?.();
      if (!mountedRef.current) return;
      if (!speechStatus?.ready) {
        toast.error(t("composer.local_voice_setup_required"), {
          description: `${speechStatus?.reason ?? ""} ${speechStatus?.setupCommand ?? "pnpm local-voice:setup"}`.trim(),
        });
        setPhase("idle");
        return;
      }

      const permission = await bridge?.askMicrophoneAccess?.();
      if (!mountedRef.current) return;
      if (permission && !permission.granted) {
        throw new Error(t("composer.local_voice_permission_denied"));
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const selectedMimeType = preferredAudioType();
      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        releaseMicrophone();
        setPhase("idle");
        toast.error(t("composer.local_voice_failed"));
      };
      recorder.onstop = () => {
        void transcribeRecording(recorder.mimeType || selectedMimeType || "audio/webm");
      };
      recorder.start(250);
      setPhase("recording");
      recordingTimeoutRef.current = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, MAX_RECORDING_DURATION_MS);
    } catch (error) {
      releaseMicrophone();
      setPhase("idle");
      if (mountedRef.current) {
        toast.error(t("composer.local_voice_failed"), { description: describeError(error) });
      }
    }
  };

  const handleClick = () => {
    if (phaseRef.current === "recording") {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      return;
    }
    if (phaseRef.current === "idle") {
      setPhase("preparing");
      void startRecording();
    }
  };

  const label = phase === "recording"
    ? t("composer.local_voice_stop")
    : phase === "preparing"
      ? t("composer.local_voice_preparing")
      : phase === "transcribing"
        ? t("composer.local_voice_transcribing")
        : t("composer.local_voice_start");

  return (
    <button
      type="button"
      className={`inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-gray-3 ${
        phase === "recording" ? "text-red-10" : "text-gray-10"
      }`}
      onClick={handleClick}
      disabled={props.disabled || phase === "preparing" || phase === "transcribing"}
      aria-label={label}
      aria-pressed={phase === "recording"}
      title={label}
    >
      {phase === "recording" ? (
        <Square size={14} fill="currentColor" />
      ) : phase === "preparing" || phase === "transcribing" ? (
        <LoaderCircle size={16} className="animate-spin" />
      ) : (
        <Mic size={16} />
      )}
    </button>
  );
}
