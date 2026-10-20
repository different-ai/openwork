import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const MODEL_RELEASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";
const TRANSDUCER_FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];

/** Speech models OpenWork can download and run on this computer. The first one is the default. */
export const DICTATION_MODELS = [
  {
    id: "parakeet-110m-en",
    label: "Parakeet 110M",
    description: "English. Fast and accurate.",
    archive: "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8",
    downloadBytes: 108_000_000,
  },
  {
    id: "parakeet-0.6b-v3",
    label: "Parakeet 0.6B v3",
    description: "English and 24 European languages, detected automatically.",
    archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    downloadBytes: 487_000_000,
  },
];

function findModel(modelId) {
  const model = DICTATION_MODELS.find((entry) => entry.id === modelId);
  if (!model) throw new Error(`Unknown speech model: ${String(modelId)}`);
  return model;
}

// Runs the native recognizer off the main process thread so loading a model never stalls windows.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const sherpa = require(workerData.modulePath);
const recognizers = new Map();
parentPort.on("message", ({ id, modelDir, samples }) => {
  try {
    let recognizer = recognizers.get(modelDir);
    if (!recognizer) {
      recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: modelDir + "/encoder.int8.onnx",
            decoder: modelDir + "/decoder.int8.onnx",
            joiner: modelDir + "/joiner.int8.onnx",
          },
          tokens: modelDir + "/tokens.txt",
          modelType: "nemo_transducer",
          numThreads: 2,
          provider: "cpu",
          debug: 0,
        },
      });
      recognizers.set(modelDir, recognizer);
    }
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    recognizer.decode(stream);
    parentPort.postMessage({ id, text: recognizer.getResult(stream).text });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

function extractArchive(archivePath, destination) {
  return new Promise((resolve, reject) => {
    // tar ships with macOS, Linux and Windows 10+, and reads bzip2 archives on all three.
    const child = spawn("tar", ["-xjf", archivePath, "-C", destination], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Couldn't unpack the speech model (tar exited ${code}). ${stderr.trim()}`.trim()));
    });
  });
}

async function hasModelFiles(modelDir) {
  try {
    await Promise.all(TRANSDUCER_FILES.map((file) => stat(path.join(modelDir, file))));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ modelsDir: string; fetch: typeof globalThis.fetch }} options
 */
export function createDictationService(options) {
  const { modelsDir } = options;
  /** @type {Map<string, { receivedBytes: number; totalBytes: number }>} */
  const downloads = new Map();
  /** @type {Map<string, string>} */
  const failures = new Map();
  /** @type {Worker | null} */
  let worker = null;
  let nextRequestId = 0;
  /** @type {Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>} */
  const pending = new Map();

  const modelDir = (model) => path.join(modelsDir, model.id);

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { modulePath: require.resolve("sherpa-onnx-node") } });
    worker.on("message", ({ id, text, error }) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (pending.size === 0) worker?.unref();
      if (error) request.reject(new Error(error));
      else request.resolve(text);
    });
    worker.on("error", (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      worker = null;
    });
    worker.unref();
    return worker;
  }

  /** @returns {Promise<import("@openwork/types/desktop-ipc").DictationModelStatus>} */
  async function status(modelId) {
    const model = findModel(modelId);
    const download = downloads.get(model.id);
    if (download) return { state: "downloading", ...download };
    if (await hasModelFiles(modelDir(model))) return { state: "ready" };
    const error = failures.get(model.id);
    return error ? { state: "failed", error } : { state: "missing", totalBytes: model.downloadBytes };
  }

  async function runDownload(model) {
    const staging = path.join(modelsDir, `.${model.id}.download`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const response = await options.fetch(`${MODEL_RELEASE_URL}/${model.archive}.tar.bz2`);
      if (!response.ok || !response.body) throw new Error(`The model download failed (HTTP ${response.status}).`);
      const progress = downloads.get(model.id);
      progress.totalBytes = Number(response.headers.get("content-length")) || model.downloadBytes;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          progress.receivedBytes += chunk.length;
          callback(null, chunk);
        },
      });
      const archivePath = path.join(staging, "model.tar.bz2");
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(archivePath));
      await extractArchive(archivePath, staging);
      const extracted = path.join(staging, model.archive);
      if (!(await hasModelFiles(extracted))) throw new Error("The downloaded speech model is missing files.");
      for (const entry of await readdir(extracted)) {
        if (!TRANSDUCER_FILES.includes(entry)) await rm(path.join(extracted, entry), { recursive: true, force: true });
      }
      await rm(modelDir(model), { recursive: true, force: true });
      await rename(extracted, modelDir(model));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async function download(modelId) {
    const model = findModel(modelId);
    if (!downloads.has(model.id) && !(await hasModelFiles(modelDir(model)))) {
      failures.delete(model.id);
      downloads.set(model.id, { receivedBytes: 0, totalBytes: model.downloadBytes });
      void runDownload(model)
        .catch((error) => failures.set(model.id, error instanceof Error ? error.message : String(error)))
        .finally(() => downloads.delete(model.id));
    }
    return status(model.id);
  }

  async function remove(modelId) {
    const model = findModel(modelId);
    if (downloads.has(model.id)) throw new Error("Wait for the download to finish before removing the model.");
    if (worker) {
      await worker.terminate();
      worker = null;
    }
    await rm(modelDir(model), { recursive: true, force: true });
    failures.delete(model.id);
    return status(model.id);
  }

  async function transcribe(modelId, samples) {
    const model = findModel(modelId);
    if (!(samples instanceof Float32Array)) throw new Error("Dictation audio must be 16 kHz mono samples.");
    if (!(await hasModelFiles(modelDir(model)))) throw new Error("The speech model isn't downloaded yet.");
    const id = nextRequestId++;
    const text = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ensureWorker().ref();
      worker.postMessage({ id, modelDir: modelDir(model), samples });
    });
    return { text: text.trim() };
  }

  return {
    models: () => DICTATION_MODELS.map(({ id, label, description, downloadBytes }) => ({ id, label, description, downloadBytes })),
    status,
    download,
    remove,
    transcribe,
  };
}
