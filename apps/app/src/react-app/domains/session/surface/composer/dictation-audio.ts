import type { DictationSettings } from "./dictation-store";

const TARGET_SAMPLE_RATE = 16_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export class DictationError extends Error {}

/**
 * Whisper-style servers all accept 16 kHz mono PCM WAV, while browsers record
 * WebM/Opus or MP4. Decode the recording and resample it so any
 * OpenAI-compatible server works without ffmpeg on its side.
 */
export async function recordingToWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await recording.arrayBuffer());
  } finally {
    void context.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Whisper marks silence and noise with bracketed tags instead of words. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]|\((?:silence|music|noise)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** POST a recording to an OpenAI-compatible `/v1/audio/transcriptions` endpoint. */
export async function transcribeRecording(audio: Blob, settings: DictationSettings): Promise<string> {
  const body = new FormData();
  body.append("file", audio, "dictation.wav");
  body.append("model", settings.model.trim());
  body.append("response_format", "json");
  if (settings.language.trim()) body.append("language", settings.language.trim());

  let response: Response;
  try {
    response = await fetch(settings.endpoint.trim(), {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch {
    throw new DictationError(`Couldn't reach the transcription server at ${settings.endpoint.trim()}. Start it, or change its address in Settings > Voice dictation.`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new DictationError(`The transcription server answered ${response.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : "."}`);
  }
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string") {
      return cleanTranscript(payload.text);
    }
  } catch {
    return cleanTranscript(text);
  }
  throw new DictationError("The transcription server's reply had no text in it.");
}
