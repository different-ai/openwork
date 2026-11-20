import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { browserScript, captureBrowserFilm, clickAt, evaluateOnSurface, hoverAt, waitForLocated, type Surface, type Target } from "@openwork/cdp";
import { isRecord } from "./packaged-sandbox-fixtures.ts";

export const exec = promisify(execFile);
export const ffmpeg = "/usr/local/bin/ffmpeg";
const scale = "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos:out_range=tv,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
export const testId = (id: string) => ({ testId: id });
export const button = (label: string | RegExp): Target => ({ role: "button", label });
export function requireDemo(condition: unknown, label: string): asserts condition { if (!condition) throw new Error(label); }
export async function poll<T>(label: string, read: () => Promise<T>, test: (value: T) => boolean, ms = 20_000, interval = 150): Promise<T> {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (test(value)) return value;
    await delay(interval);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
export function motion(surface: Surface, signal: AbortSignal) {
  const check = () => signal.throwIfAborted();
  async function cursor(x?: number, y?: number) {
    await evaluateOnSurface(surface, browserScript((x, y) => {
      let cursor = document.getElementById("ow-demo-cursor");
      if (!cursor) {
        cursor = document.createElement("div");
        cursor.id = "ow-demo-cursor";
        cursor.setAttribute("aria-hidden", "true");
        cursor.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;top:72%;left:70%;width:24px;height:24px;transition:left 590ms ease-in-out,top 590ms ease-in-out;";
        cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M2 1l7 20 3-8 8-3z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        document.documentElement.append(cursor);
      }
      if (x !== null && y !== null) { cursor.style.left = `${x - 2}px`; cursor.style.top = `${y - 1}px`; }
    }, [x ?? null, y ?? null]));
  }
  async function click(target: Target, after = 550) {
    check();
    const found = await waitForLocated(surface, target, { timeoutMs: 8500, mustHitTest: true }).catch(() => {
      throw new Error(`Could not click ${typeof target === "string" ? target : target.testId ?? String(target.label ?? target.text)}`);
    });
    await cursor();
    await cursor(found.center.x, found.center.y);
    await delay(620, undefined, { signal });
    await hoverAt(surface, found.center);
    await clickAt(surface, found.center);
    await cursor();
    if (after) await delay(after, undefined, { signal });
  }
  async function type(text: string) {
    await click("composer", 100);
    for (const char of text) {
      check();
      await surface.client.send("Input.insertText", { text: char });
      await delay(40 + Math.random() * 40, undefined, { signal });
    }
  }
  async function see(id: string, timeoutMs = 20_000) { return waitForLocated(surface, testId(id), { timeoutMs }); }
  async function maybeClick(target: Target) {
    if (!await waitForLocated(surface, target, { timeoutMs: 500, mustHitTest: true }).catch(() => null)) return false;
    await click(target);
    return true;
  }
  async function still(path: string) {
    const result: unknown = await surface.client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    requireDemo(isRecord(result) && typeof result.data === "string", "CDP returned no screenshot");
    await writeFile(path, Buffer.from(result.data, "base64"));
  }
  return { click, type, see, cursor, still, maybeClick };
}

export async function film<T>(surface: Surface, directory: string, signal: AbortSignal, action: (ui: ReturnType<typeof motion>, started: number) => Promise<T>, minMs = 20_250, png = surface.handle.kind === "electron") {
  const ui = motion(surface, signal);
  await surface.client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 810, deviceScaleFactor: 2, mobile: false });
  await surface.client.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 255, g: 255, b: 255, a: 1 } });
  await ui.cursor();
  await delay(550, undefined, { signal });
  process.env.OPENWORK_FILM_MAX_SIZE = "2880x1620";
  process.env.OPENWORK_FILM_QUALITY = "90";
  const capture = png ? await captureScreenshotFilm(surface, directory) : await captureBrowserFilm(surface, directory);
  const started = Date.now();
  try {
    await delay(1200, undefined, { signal });
    const outcome = await action(ui, started);
    await delay(Math.max(2500, minMs - (Date.now() - started)), undefined, { signal });
    return outcome;
  } finally { await capture.stop(); }
}

async function captureScreenshotFilm(surface: Surface, directory: string) {
  await mkdir(directory, { recursive: true });
  const frames: { file: string; timestamp: number }[] = [];
  let active = true;
  const loop = (async () => {
    while (active) {
      const at = performance.now();
      const result: unknown = await surface.client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, optimizeForSpeed: true }, { timeoutMs: 4000 });
      requireDemo(isRecord(result) && typeof result.data === "string", "CDP returned no film frame");
      const file = `${String(frames.length).padStart(6, "0")}.png`;
      await writeFile(join(directory, file), Buffer.from(result.data, "base64"));
      frames.push({ file, timestamp: (performance.timeOrigin + at) / 1000 });
      await delay(Math.max(1, 33 - (performance.now() - at)));
    }
  })().then(() => null, (error: unknown) => ({ error }));
  return { async stop() {
    const stoppedAt = performance.timeOrigin + performance.now();
    active = false;
    const failure = await loop;
    if (failure) throw failure.error;
    await writeFile(join(directory, "capture.json"), JSON.stringify({ frames: frames.filter(frame => frame.timestamp < stoppedAt / 1000), stoppedAt }));
  } };
}

async function frameList(directory: string) {
  const manifest: unknown = JSON.parse(await readFile(join(directory, "capture.json"), "utf8"));
  requireDemo(isRecord(manifest) && Array.isArray(manifest.frames) && typeof manifest.stoppedAt === "number", "Missing capture manifest");
  const frames = manifest.frames.filter(isRecord).flatMap(frame => typeof frame.file === "string" && typeof frame.timestamp === "number" ? [{ file: join(directory, frame.file), timestamp: frame.timestamp }] : []);
  requireDemo(frames.length > 10, "Screencast has too few frames");
  return { frames, stop: manifest.stoppedAt / 1000 };
}
export async function sampledStill(directory: string, epochMs: number, path: string) {
  const { frames } = await frameList(directory);
  const frame = frames.find(entry => entry.timestamp >= epochMs / 1000);
  if (frame?.file.endsWith(".png")) await copyFile(frame.file, path);
  else if (frame) await exec(ffmpeg, ["-y", "-loglevel", "error", "-i", frame.file, "-frames:v", "1", path], { timeout: 10_000 });
}
export async function encode(directories: string[], output: string, scratch: string, name: string) {
  const clip = join(output, `${name}.mp4`);
  const segments: string[] = [];
  const composite = `color=c=white:s=1920x1080:r=30[paper];[0:v]${scale},format=rgba,fps=30[app];[paper][app]overlay=shortest=1:format=yuv420`;
  for (const [segment, directory] of directories.entries()) {
    const { frames, stop } = await frameList(directory);
    const first = frames[0];
    const last = frames.at(-1);
    requireDemo(first && last, "No frames to encode");
    const list = frames.map((frame, index) => {
      const duration = Math.max(0.001, (frames[index + 1]?.timestamp ?? stop) - frame.timestamp);
      return `file '${frame.file}'\noption framerate 1000\nduration ${duration.toFixed(4)}`;
    });
    list.push(`file '${last.file}'\noption framerate 1000`);
    const concat = join(scratch, `${segment}.ffconcat`);
    await writeFile(concat, list.join("\n") + "\n");
    const target = directories.length === 1 ? clip : join(scratch, `${segment}.mp4`);
    await exec(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-filter_complex_threads", "3", "-filter_complex", composite, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "fast", "-movflags", "+faststart", target], { timeout: 95_000 });
    segments.push(target);
  }
  if (segments.length > 1) {
    const splice = join(scratch, "segments.ffconcat");
    await writeFile(splice, segments.map(file => `file '${file}'`).join("\n") + "\n");
    await exec(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", splice, "-c", "copy", "-movflags", "+faststart", clip], { timeout: 15_000 });
  }
  const { stdout } = await exec("/opt/homebrew/bin/ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate,pix_fmt:format=duration,size", "-of", "json", clip], { timeout: 10_000 });
  const probe: unknown = JSON.parse(stdout);
  requireDemo(isRecord(probe) && isRecord(probe.format) && Array.isArray(probe.streams), "Invalid ffprobe receipt");
  const stream: unknown = probe.streams[0];
  const seconds = Number(probe.format.duration);
  const bytes = Number(probe.format.size);
  requireDemo(isRecord(stream) && stream.codec_name === "h264" && stream.width === 1920 && stream.height === 1080 && stream.r_frame_rate === "30/1" && stream.pix_fmt === "yuv420p" && seconds > 0 && bytes > 0, "Unexpected output format");
  const maxFrames = Math.ceil(seconds / 2);
  const rows = Math.max(4, Math.ceil(maxFrames / 5));
  await exec(ffmpeg, ["-y", "-loglevel", "error", "-i", clip, "-vf", `fps=1/2,scale=640:-1,tile=5x${rows}`, "-frames:v", "1", "-q:v", "3", join(output, `${name}-sheet.jpg`)], { timeout: 35_000 });
  const reviewPaths: string[] = [];
  for (const [i, t] of [0.8, seconds / 3, seconds * 0.65, seconds - 1.4].entries()) {
    const framePath = join(output, `${name}-review-${i + 1}.jpg`);
    await exec(ffmpeg, ["-y", "-loglevel", "error", "-ss", Math.max(0, t).toFixed(3), "-i", clip, "-frames:v", "1", "-q:v", "2", framePath], { timeout: 15_000 });
    reviewPaths.push(framePath);
  }
  return { seconds, bytes, format: "1920×1080 / 30 fps / H.264 yuv420p", reviewPaths };
}
export async function publishStills(stills: string[], output: string) {
  for (const still of stills) await copyFile(still, join(output, still.split("/").at(-1) ?? "still.png"));
}
