import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MODEL = process.env.OPENWORK_LOCAL_SPEECH_MODEL?.trim()
  || "mlx-community/whisper-large-v3-turbo";
const VOICE_HOME = process.env.OPENWORK_LOCAL_SPEECH_HOME?.trim()
  || path.join(os.homedir(), ".openwork", "local-voice");
const VENV_PATH = path.join(VOICE_HOME, "venv");
const VENV_PYTHON = path.join(VENV_PATH, "bin", "python");
const HF_HOME = process.env.HF_HOME?.trim() || path.join(VOICE_HOME, "huggingface");

async function isExecutable(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate && await isExecutable(candidate)) return candidate;
  }
  return null;
}

function pathCandidates(name) {
  const candidates = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.join(entry, name));
  return [...new Set(candidates)];
}

function run(command, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("OpenWork local voice currently requires an Apple Silicon Mac.");
}

const ffmpeg = await findExecutable([
  process.env.OPENWORK_LOCAL_SPEECH_FFMPEG?.trim(),
  ...pathCandidates("ffmpeg"),
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
]);
if (!ffmpeg) {
  throw new Error("ffmpeg was not found. Install it with `brew install ffmpeg`, then run this command again.");
}

await mkdir(VOICE_HOME, { recursive: true, mode: 0o700 });
await mkdir(HF_HOME, { recursive: true, mode: 0o700 });

if (!await isExecutable(VENV_PYTHON)) {
  const python = await findExecutable([
    process.env.OPENWORK_LOCAL_SPEECH_BOOTSTRAP_PYTHON?.trim(),
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.13",
    ...pathCandidates("python3.11"),
    ...pathCandidates("python3.12"),
    ...pathCandidates("python3.13"),
    ...pathCandidates("python3"),
    "/usr/bin/python3",
  ]);
  if (!python) throw new Error("Python 3 was not found.");
  console.log(`Creating local speech environment with ${python}`);
  await run(python, ["-m", "venv", VENV_PATH]);
}

const environment = {
  ...process.env,
  HF_HOME,
  PATH: [path.dirname(ffmpeg), process.env.PATH].filter(Boolean).join(path.delimiter),
};

console.log("Installing mlx-whisper locally (no OpenAI service is used)...");
await run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip"], environment);
await run(VENV_PYTHON, ["-m", "pip", "install", "mlx-whisper==0.4.3"], environment);

console.log(`Downloading ${MODEL} to ${HF_HOME}...`);
await run(
  VENV_PYTHON,
  [
    "-c",
    "from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1])",
    MODEL,
  ],
  environment,
);

await writeFile(
  path.join(VOICE_HOME, "ready.json"),
  `${JSON.stringify({ model: MODEL, installedAt: new Date().toISOString() }, null, 2)}\n`,
  { mode: 0o600 },
);

console.log(`Local voice is ready. Model: ${MODEL}`);
console.log(`Environment: ${VOICE_HOME}`);
