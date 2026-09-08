export interface RecordedFrame {
  file: string;
  seconds: number;
}
export interface RecordedDownload {
  seconds: number;
  guid: string;
  state: string;
  receivedBytes: number;
  totalBytes: number;
}
export interface BrowserRecording {
  frames: RecordedFrame[];
  downloads: RecordedDownload[];
  durationSeconds: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected capture object");
  return Object.fromEntries(Object.entries(value));
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected finite capture timestamp or byte count");
  return value;
}

/** Convert the existing CDP capture file into JSON-serializable Remotion props. */
export function recordingFromCapture(value: unknown): BrowserRecording {
  const capture = record(value);
  if (
    capture.format !== "cdp-screencast" ||
    !Array.isArray(capture.frames) ||
    capture.frames.length === 0
  ) {
    throw new Error("Expected a nonempty CDP screencast");
  }
  const rawFrames = capture.frames.map(record);
  const first = finite(rawFrames[0].timestamp);
  const frames = rawFrames.map((frame) => {
    if (
      typeof frame.file !== "string" ||
      !/^frames\/[0-9]+\.jpg$/.test(frame.file)
    )
      throw new Error("Unsafe capture frame path");
    return { file: frame.file, seconds: finite(frame.timestamp) - first };
  });
  if (
    frames.some(
      (frame, index) =>
        frame.seconds < 0 ||
        (index > 0 && frame.seconds < frames[index - 1].seconds),
    )
  ) {
    throw new Error("Capture frames are not chronological");
  }
  if (!Array.isArray(capture.downloads))
    throw new Error("Expected capture downloads");
  const downloads = capture.downloads
    .map(record)
    .filter((event) => event.event === "Browser.downloadProgress")
    .map((event) => {
      if (typeof event.guid !== "string" || typeof event.state !== "string")
        throw new Error("Invalid download event");
      const receivedBytes = finite(event.receivedBytes);
      const totalBytes = finite(event.totalBytes);
      if (receivedBytes < 0 || totalBytes < 0)
        throw new Error("Negative download byte count");
      return {
        guid: event.guid,
        state: event.state,
        seconds: Math.max(0, finite(event.receivedAt) / 1000 - first),
        receivedBytes,
        totalBytes,
      };
    })
    .sort((a, b) => a.seconds - b.seconds);
  return {
    frames,
    downloads,
    durationSeconds: Math.max(
      frames[frames.length - 1].seconds,
      finite(capture.stoppedAt) / 1000 - first,
    ),
  };
}

/** Return the last frame actually painted at this source time. */
export function frameAt(
  frames: readonly RecordedFrame[],
  seconds: number,
): RecordedFrame {
  if (frames.length === 0) throw new Error("Recording has no frames");
  let low = 0,
    high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle].seconds <= seconds) low = middle;
    else high = middle - 1;
  }
  return frames[low];
}
