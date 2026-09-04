import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LOCAL_SPEECH_MODEL = "mlx-community/whisper-large-v3-turbo";
export const MAX_LOCAL_SPEECH_AUDIO_BYTES = 25 * 1024 * 1024;

const TRANSCRIBE_SCRIPT = String.raw`
import json
import sys
import mlx_whisper

audio_path, model, language = sys.argv[1:4]
result = mlx_whisper.transcribe(
    audio_path,
    path_or_hf_repo=model,
    language=language or None,
    verbose=False,
    condition_on_previous_text=False,
)
print(json.dumps({
    "text": result.get("text", ""),
    "language": result.get("language"),
}, ensure_ascii=False))
`.trim();

const MIME_EXTENSIONS = new Map([
  ["audio/webm", ".webm"],
  ["audio/ogg", ".ogg"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["audio/x-wav", ".wav"],
  ["audio/aiff", ".aiff"],
  ["audio/x-aiff", ".aiff"],
]);

function withoutCodec(mimeType) {
  return String(mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function audioExtensionForMimeType(mimeType) {
  return MIME_EXTENSIONS.get(withoutCodec(mimeType)) ?? null;
}

export function normalizeLocalSpeechAudio(value) {
  let bytes = null;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("The recording is empty.");
  }
  if (bytes.byteLength > MAX_LOCAL_SPEECH_AUDIO_BYTES) {
    throw new Error("The recording is too large. Keep local dictation under 60 seconds.");
  }
  return bytes;
}

function pathCandidates(name, environment) {
  const candidates = [];
  for (const entry of String(environment.PATH ?? "").split(path.delimiter)) {
    if (entry) candidates.push(path.join(entry, name));
  }
  if (process.platform === "darwin") {
    candidates.push(path.join("/opt/homebrew/bin", name), path.join("/usr/local/bin", name));
  }
  return [...new Set(candidates)];
}

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue looking for the next executable.
    }
  }
  return null;
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function appendOutput(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length > 1024 * 1024 ? next.slice(-1024 * 1024) : next;
}

function runProcess(command, args, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Local transcription timed out.")));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? "unknown"}`;
        reject(new Error(`Local transcription failed (${code ?? "no exit code"}): ${detail}`));
      });
    });
  });
}

function parseTranscriptionOutput(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const result = JSON.parse(lines[index]);
      if (result && typeof result.text === "string") {
        return {
          text: result.text.trim(),
          language: typeof result.language === "string" ? result.language : null,
        };
      }
    } catch {
      // mlx-whisper dependencies may log to stdout; keep looking for our JSON line.
    }
  }
  throw new Error("Local transcription returned an unreadable response.");
}

export function createLocalSpeechService(options = {}) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const voiceHome = environment.OPENWORK_LOCAL_SPEECH_HOME?.trim()
    || path.join(homeDirectory, ".openwork", "local-voice");
  const pythonOverride = environment.OPENWORK_LOCAL_SPEECH_PYTHON?.trim();
  const ffmpegOverride = environment.OPENWORK_LOCAL_SPEECH_FFMPEG?.trim();
  const pythonPath = pythonOverride || path.join(voiceHome, "venv", "bin", "python");
  const model = environment.OPENWORK_LOCAL_SPEECH_MODEL?.trim() || DEFAULT_LOCAL_SPEECH_MODEL;
  const cacheDirectory = path.join(voiceHome, "huggingface");
  const readyMarkerPath = path.join(voiceHome, "ready.json");
  let transcriptionActive = false;

  async function status() {
    if (platform !== "darwin" || architecture !== "arm64") {
      return {
        supported: false,
        ready: false,
        model,
        reason: "Local voice currently requires an Apple Silicon Mac.",
        setupCommand: "pnpm local-voice:setup",
      };
    }
    const resolvedPython = await firstExecutable([pythonPath]);
    const environmentReady = Boolean(pythonOverride) || await exists(readyMarkerPath);
    const resolvedFfmpeg = await firstExecutable(
      ffmpegOverride ? [ffmpegOverride] : pathCandidates("ffmpeg", environment),
    );
    if (!resolvedPython || !environmentReady) {
      return {
        supported: true,
        ready: false,
        model,
        reason: "The local speech environment is not installed.",
        setupCommand: "pnpm local-voice:setup",
      };
    }
    if (!resolvedFfmpeg) {
      return {
        supported: true,
        ready: false,
        model,
        reason: "ffmpeg is required for local speech recognition.",
        setupCommand: "brew install ffmpeg && pnpm local-voice:setup",
      };
    }
    return {
      supported: true,
      ready: true,
      model,
      pythonPath: resolvedPython,
      ffmpegPath: resolvedFfmpeg,
      setupCommand: "pnpm local-voice:setup",
    };
  }

  async function transcribe(input) {
    const currentStatus = await status();
    if (!currentStatus.ready) {
      throw new Error(`${currentStatus.reason} Run: ${currentStatus.setupCommand}`);
    }
    const mimeType = withoutCodec(input?.mimeType);
    const extension = audioExtensionForMimeType(mimeType);
    if (!extension) throw new Error(`Unsupported local recording format: ${mimeType || "unknown"}.`);
    const bytes = normalizeLocalSpeechAudio(input?.audio);
    const language = typeof input?.language === "string" ? input.language.trim() : "";
    if (transcriptionActive) throw new Error("Another local transcription is already running.");
    transcriptionActive = true;
    let temporaryDirectory = null;
    const startedAt = Date.now();
    try {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "openwork-local-voice-"));
      const audioPath = path.join(temporaryDirectory, `recording${extension}`);
      await writeFile(audioPath, bytes, { mode: 0o600 });
      const processPath = path.dirname(currentStatus.ffmpegPath);
      const childEnvironment = {
        ...environment,
        HF_HOME: environment.HF_HOME?.trim() || cacheDirectory,
        PATH: [processPath, environment.PATH].filter(Boolean).join(path.delimiter),
      };
      const result = await runProcess(
        currentStatus.pythonPath,
        ["-c", TRANSCRIBE_SCRIPT, audioPath, model, language],
        {
          env: childEnvironment,
          spawnProcess: options.spawnProcess,
          timeoutMs: options.timeoutMs,
        },
      );
      return {
        ...parseTranscriptionOutput(result.stdout),
        model,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      transcriptionActive = false;
    }
  }

  return { status, transcribe };
}
