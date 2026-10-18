import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { MCP_QUICK_CONNECT } from "@/app/constants";
import { useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider";
import { isOpenWorkExtensionEnabled, OPENWORK_EXTENSION_STATE_CHANGED, setOpenWorkExtensionEnabled } from "@/react-app/domains/settings/extension-state";
import { DICTATION_SAMPLE_RATE, DictationError, encodeWav, recordingToSamples, transcribeRecording } from "./dictation-audio";
import { transcribeWithBuiltinModel } from "./dictation-builtin";
import { useDictationStore } from "./dictation-store";

export type DictationStatus = "idle" | "recording" | "transcribing";

function subscribeExtensionState(onChange: () => void) {
  window.addEventListener(OPENWORK_EXTENSION_STATE_CHANGED, onChange);
  return () => window.removeEventListener(OPENWORK_EXTENSION_STATE_CHANGED, onChange);
}

const dictationExtension = () => MCP_QUICK_CONNECT.find((item) => item.id === "voice-dictation");

function readDictationExtensionEnabled() {
  const entry = dictationExtension();
  return entry ? isOpenWorkExtensionEnabled(entry) : false;
}

export function setDictationExtensionEnabled(enabled: boolean) {
  const entry = dictationExtension();
  if (entry) setOpenWorkExtensionEnabled(entry, enabled);
}

export function useDictationExtensionEnabled(): boolean {
  return useSyncExternalStore(subscribeExtensionState, readDictationExtensionEnabled, () => false);
}

function microphoneSupported() {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined";
}

/** The mic shows only when the member turned on Voice dictation and their organization allows built-in extensions. */
export function useDictationAvailable(): boolean {
  const restrictions = useOrgRestrictions();
  return useDictationExtensionEnabled() && restrictions.allowBuiltInExtensions !== false && microphoneSupported();
}

export function useDictation(options: {
  builtinModelId: string;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const discardRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback(async (chunks: Blob[], mimeType: string) => {
    if (discardRef.current || chunks.length === 0) {
      setStatus("idle");
      return;
    }
    setStatus("transcribing");
    try {
      const samples = await recordingToSamples(new Blob(chunks, { type: mimeType }));
      const { engine, endpoint, model, language } = useDictationStore.getState();
      const text = engine === "builtin"
        ? await transcribeWithBuiltinModel(optionsRef.current.builtinModelId, samples)
        : await transcribeRecording(encodeWav(samples, DICTATION_SAMPLE_RATE), { endpoint, model, language });
      if (text) {
        useDictationStore.getState().addTranscript(text);
        optionsRef.current.onTranscript(text);
      }
    } catch (error) {
      optionsRef.current.onError(error instanceof DictationError ? error.message : "Couldn't turn that recording into text. Try again.");
    } finally {
      setStatus("idle");
    }
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      optionsRef.current.onError("OpenWork can't use your microphone. Allow microphone access for OpenWork in your system settings, then try again.");
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    discardRef.current = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      void finish(chunks, recorder.mimeType);
    };
    recorderRef.current = recorder;
    recorder.start();
    setStatus("recording");
  }, [finish]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const cancel = useCallback(() => {
    discardRef.current = true;
    stop();
  }, [stop]);

  useEffect(() => cancel, [cancel]);

  const toggle = useCallback(() => {
    if (status === "recording") stop();
    else if (status === "idle") void start();
  }, [start, status, stop]);

  return { status, toggle, cancel };
}
