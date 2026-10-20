import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DictationModelInfo, DictationModelStatus } from "@openwork/types/desktop-ipc";

import { desktopBridge } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { cleanTranscript, DictationError } from "./dictation-audio";
import { useDictationStore } from "./dictation-store";
import type { WebDictationCommand, WebDictationRequest, WebDictationResponse } from "./dictation-web-worker";

export type { DictationModelInfo, DictationModelStatus };

/** A speech model OpenWork downloads once and then runs on this computer, without a separate server. */
type BuiltinDictationEngine = {
  models: () => Promise<DictationModelInfo[]>;
  status: (modelId: string) => Promise<DictationModelStatus>;
  download: (modelId: string) => Promise<DictationModelStatus>;
  remove: (modelId: string) => Promise<DictationModelStatus>;
  transcribe: (modelId: string, samples: Float32Array) => Promise<string>;
};

const desktopEngine: BuiltinDictationEngine = {
  models: () => desktopBridge.dictationModels(),
  status: (modelId) => desktopBridge.dictationModelStatus(modelId),
  download: (modelId) => desktopBridge.dictationModelDownload(modelId),
  remove: (modelId) => desktopBridge.dictationModelRemove(modelId),
  transcribe: async (modelId, samples) => cleanTranscript((await desktopBridge.dictationTranscribe(modelId, samples)).text),
};

// The web client can't run native code, so it runs Whisper in a browser worker instead.
const WEB_MODEL: DictationModelInfo = {
  id: "whisper-base.en",
  label: "Whisper base",
  description: "English. Runs in your browser.",
  downloadBytes: 78_000_000,
};
const WEB_READY_KEY = "openwork.dictation.webModelReady";
const WEB_CACHE_NAME = "transformers-cache";

function createWebEngine(): BuiltinDictationEngine {
  let worker: Worker | null = null;
  let nextId = 0;
  let download: { receivedBytes: number; totalBytes: number } | null = null;
  let failure: string | null = null;
  const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("./dictation-web-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WebDictationResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        // Files report their sizes as each one starts, so the known model size keeps the percentage from jumping back.
        if (download) download = { receivedBytes: message.receivedBytes, totalBytes: Math.max(message.totalBytes, WEB_MODEL.downloadBytes) };
        return;
      }
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.type === "failed") request?.reject(new Error(message.error));
      else request?.resolve(message.type === "transcribed" ? message.text : "");
    };
    return worker;
  }

  function send(command: WebDictationCommand) {
    const id = nextId++;
    return new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const request: WebDictationRequest = { ...command, id };
      ensureWorker().postMessage(request);
    });
  }

  function webStatus(): DictationModelStatus {
    if (download) return { state: "downloading", ...download };
    if (localStorage.getItem(WEB_READY_KEY) === "1") return { state: "ready" };
    return failure ? { state: "failed", error: failure } : { state: "missing", totalBytes: WEB_MODEL.downloadBytes };
  }

  return {
    models: async () => [WEB_MODEL],
    status: async () => webStatus(),
    download: async () => {
      if (!download && webStatus().state !== "ready") {
        failure = null;
        download = { receivedBytes: 0, totalBytes: WEB_MODEL.downloadBytes };
        void send({ type: "load" })
          .then(() => localStorage.setItem(WEB_READY_KEY, "1"))
          .catch((error: unknown) => {
            failure = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            download = null;
          });
      }
      return webStatus();
    },
    remove: async () => {
      worker?.terminate();
      worker = null;
      localStorage.removeItem(WEB_READY_KEY);
      await caches.delete(WEB_CACHE_NAME);
      return webStatus();
    },
    transcribe: async (_modelId, samples) => cleanTranscript(await send({ type: "transcribe", samples })),
  };
}

let webEngine: BuiltinDictationEngine | null = null;

export function builtinDictationEngine(): BuiltinDictationEngine {
  if (isDesktopRuntime()) return desktopEngine;
  webEngine ??= createWebEngine();
  return webEngine;
}

export function useBuiltinModelId(): string {
  const desktopModel = useDictationStore((state) => state.desktopModel);
  return isDesktopRuntime() ? desktopModel : WEB_MODEL.id;
}

export function useBuiltinModels() {
  return useQuery({
    queryKey: ["dictation", "models"],
    queryFn: () => builtinDictationEngine().models(),
    staleTime: Infinity,
  });
}

const statusKey = (modelId: string) => ["dictation", "model-status", modelId];

export function useBuiltinModelStatus(modelId: string) {
  return useQuery({
    queryKey: statusKey(modelId),
    queryFn: () => builtinDictationEngine().status(modelId),
    refetchInterval: (query) => query.state.data?.state === "downloading" ? 500 : false,
  });
}

export function useBuiltinModelActions(modelId: string) {
  const queryClient = useQueryClient();
  const settle = (status: DictationModelStatus) => {
    queryClient.setQueryData(statusKey(modelId), status);
    return status;
  };
  return {
    download: async () => settle(await builtinDictationEngine().download(modelId)),
    remove: async () => settle(await builtinDictationEngine().remove(modelId)),
  };
}

export async function transcribeWithBuiltinModel(modelId: string, samples: Float32Array): Promise<string> {
  const engine = builtinDictationEngine();
  const status = await engine.status(modelId);
  if (status.state !== "ready") throw new DictationError("The speech model isn't downloaded yet. Click the mic again once the download finishes.");
  try {
    return await engine.transcribe(modelId, samples);
  } catch (error) {
    throw new DictationError(`Couldn't turn that recording into text: ${error instanceof Error ? error.message : String(error)}`);
  }
}
