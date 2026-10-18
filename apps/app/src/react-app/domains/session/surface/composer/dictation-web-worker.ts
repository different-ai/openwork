/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline, type ProgressInfo } from "@huggingface/transformers";

// Model files download from Hugging Face, and transformers.js loads ONNX Runtime's WebAssembly from
// https://cdn.jsdelivr.net/npm/onnxruntime-web/ (both declared in docs/enterprise/outbound-access.json).
env.remoteHost = "https://huggingface.co/";

export const WEB_DICTATION_MODEL = "onnx-community/whisper-base.en";

export type WebDictationCommand = { type: "load" } | { type: "transcribe"; samples: Float32Array };
export type WebDictationRequest = WebDictationCommand & { id: number };

export type WebDictationResponse =
  | { type: "progress"; receivedBytes: number; totalBytes: number }
  | { type: "loaded"; id: number }
  | { type: "transcribed"; id: number; text: string }
  | { type: "failed"; id: number; error: string };

let recognizer: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
const fileProgress = new Map<string, { loaded: number; total: number }>();

function post(message: WebDictationResponse) {
  postMessage(message);
}

function load() {
  recognizer ??= pipeline("automatic-speech-recognition", WEB_DICTATION_MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (info: ProgressInfo) => {
      if (info.status !== "progress") return;
      fileProgress.set(info.file, { loaded: info.loaded, total: info.total });
      let receivedBytes = 0;
      let totalBytes = 0;
      for (const file of fileProgress.values()) {
        receivedBytes += file.loaded;
        totalBytes += file.total;
      }
      post({ type: "progress", receivedBytes, totalBytes });
    },
  }).catch((error: unknown) => {
    recognizer = null;
    throw error;
  });
  return recognizer;
}

onmessage = async (event: MessageEvent<WebDictationRequest>) => {
  const request = event.data;
  try {
    const asr = await load();
    if (request.type === "load") {
      post({ type: "loaded", id: request.id });
      return;
    }
    const output = await asr(request.samples);
    const text = Array.isArray(output) ? output.map((chunk) => chunk.text).join(" ") : output.text;
    post({ type: "transcribed", id: request.id, text });
  } catch (error) {
    post({ type: "failed", id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
