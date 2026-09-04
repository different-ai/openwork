import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_LOCAL_SPEECH_AUDIO_BYTES,
  audioExtensionForMimeType,
  createLocalSpeechService,
  normalizeLocalSpeechAudio,
} from "./local-speech.mjs";

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {}
}

test("audioExtensionForMimeType ignores codec parameters", () => {
  assert.equal(audioExtensionForMimeType("audio/webm;codecs=opus"), ".webm");
  assert.equal(audioExtensionForMimeType("audio/mp4"), ".m4a");
  assert.equal(audioExtensionForMimeType("text/plain"), null);
});

test("normalizeLocalSpeechAudio rejects empty and oversized recordings", () => {
  assert.throws(() => normalizeLocalSpeechAudio(new Uint8Array()), /empty/);
  assert.throws(
    () => normalizeLocalSpeechAudio(new Uint8Array(MAX_LOCAL_SPEECH_AUDIO_BYTES + 1)),
    /too large/,
  );
  assert.deepEqual(normalizeLocalSpeechAudio(new Uint8Array([1, 2, 3])), new Uint8Array([1, 2, 3]));
});

test("status explains when local speech is unsupported", async () => {
  const service = createLocalSpeechService({ platform: "linux", architecture: "x64" });
  assert.deepEqual(await service.status(), {
    supported: false,
    ready: false,
    model: "mlx-community/whisper-large-v3-turbo",
    reason: "Local voice currently requires an Apple Silicon Mac.",
    setupCommand: "pnpm local-voice:setup",
  });
});

test("transcribe writes a private temporary recording and parses the worker response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-local-speech-test-"));
  const voiceHome = path.join(root, "voice");
  const pythonPath = path.join(voiceHome, "venv", "bin", "python");
  const ffmpegPath = path.join(root, "ffmpeg");
  await mkdir(path.dirname(pythonPath), { recursive: true });
  await writeFile(pythonPath, "", { mode: 0o700 });
  await writeFile(ffmpegPath, "", { mode: 0o700 });

  /** @type {{ command: string; args: string[] }[]} */
  const recordedCalls = [];
  let recordingMode = null;
  const spawnProcess = (command, args) => {
    recordedCalls.push({ command, args });
    const audioPath = args.at(-3);
    assert.ok(audioPath);
    recordingMode = statSync(audioPath).mode & 0o777;
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", '{"text":"  本地输入成功  ","language":"zh"}\n');
      child.emit("close", 0, null);
    });
    return child;
  };

  try {
    const service = createLocalSpeechService({
      platform: "darwin",
      architecture: "arm64",
      homeDirectory: root,
      environment: {
        OPENWORK_LOCAL_SPEECH_HOME: voiceHome,
        OPENWORK_LOCAL_SPEECH_PYTHON: pythonPath,
        OPENWORK_LOCAL_SPEECH_FFMPEG: ffmpegPath,
        PATH: "",
      },
      spawnProcess,
    });
    const result = await service.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm;codecs=opus",
      language: "zh",
    });
    assert.equal(result.text, "本地输入成功");
    assert.equal(result.language, "zh");
    const recordedArgs = recordedCalls[0];
    assert.ok(recordedArgs);
    assert.equal(recordedArgs.command, pythonPath);
    assert.equal(recordedArgs.args.at(-2), "mlx-community/whisper-large-v3-turbo");
    assert.equal(recordedArgs.args.at(-1), "zh");
    assert.equal(recordingMode, 0o600);
    const temporaryAudioPath = recordedArgs.args.at(-3);
    assert.ok(temporaryAudioPath);
    await assert.rejects(access(temporaryAudioPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
