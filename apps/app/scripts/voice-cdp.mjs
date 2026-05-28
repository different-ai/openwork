import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));
const cdpUrl = args.cdpUrl ?? process.env.CDP_URL ?? "http://127.0.0.1:9825";
const mode = args.mode ?? "preflight";
const text = args.text ?? "Open extension settings.";
const expectRoute = args.expectRoute ?? "";
const requireAudioPermission = args.requireAudioPermission === true;

async function main() {
  const target = await pickTarget(cdpUrl);
  const client = await connectCdp(target.webSocketDebuggerUrl);

  try {
    await waitFor(client, "Boolean(window.__openworkControl)", 15000);
    const preflight = await runPreflight(client);
    if (mode === "preflight") {
      console.log(JSON.stringify(preflight, null, 2));
      return;
    }

    await ensureVoicePanel(client);

    if (mode === "transcript" || mode === "full") {
      const transcript = await executeControl(client, "voice.inject_transcript", { text });
      console.log(JSON.stringify({ step: "transcript", result: transcript }, null, 2));
    }

    if (mode === "audio" || mode === "full") {
      const pcm16Base64 = await synthesizePcm16Base64(text);
      const audio = await executeControl(client, "voice.inject_audio", { pcm16Base64 });
      console.log(JSON.stringify({ step: "audio", result: audio }, null, 2));
      const proof = await collectProof(client, expectRoute);
      console.log(JSON.stringify({ step: "proof", result: proof }, null, 2));
    }
  } finally {
    client.close();
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--mode") parsed.mode = values[++index];
    else if (value === "--text") parsed.text = values[++index];
    else if (value === "--cdp-url") parsed.cdpUrl = values[++index];
    else if (value === "--expect-route") parsed.expectRoute = values[++index];
    else if (value === "--require-audio-permission") parsed.requireAudioPermission = true;
  }
  return parsed;
}

async function runPreflight(client) {
  const userAgent = await evaluate(client, "navigator.userAgent");
  const controlReady = await evaluate(client, "Boolean(window.__openworkControl)");
  const actions = controlReady
    ? await evaluate(client, "window.__openworkControl.listActions().map((action) => action.id)")
    : [];
  const media = await evaluate(client, `(${mediaPreflight.toString()})()`, true);

  const result = {
    ok: true,
    electron: typeof userAgent === "string" && userAgent.includes("Electron/"),
    userAgent,
    controlReady,
    voiceActions: actions.filter((id) => id.startsWith("voice.")),
    media,
  };

  if (!result.electron) throw new Error("Target is not Electron.");
  if (!controlReady) throw new Error("OpenWork control API is not available.");
  if (requireAudioPermission && !media.audio.ok) {
    throw new Error(`Audio getUserMedia failed: ${media.audio.name} ${media.audio.message}`);
  }
  if (media.video.ok) throw new Error("Video getUserMedia unexpectedly succeeded; audio-only permission guard may be broken.");
  return result;
}

async function mediaPreflight() {
  async function request(constraints) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((track) => track.stop());
      return { ok: true };
    } catch (error) {
      return { ok: false, name: error?.name ?? "Error", message: error?.message ?? String(error) };
    }
  }
  return {
    audio: await request({ audio: true }),
    video: await request({ video: true }),
  };
}

async function ensureVoicePanel(client) {
  await evaluate(client, "window.__openworkControl.setEnabled(true)");
  await evaluate(client, "window.localStorage.setItem('openwork.extension.enabled.openwork-voice', '1'); window.dispatchEvent(new CustomEvent('openwork:extension-state-changed', { detail: { id: 'openwork-voice', enabled: true } }))");
  let actions = await evaluate(client, "window.__openworkControl.listActions().map((action) => action.id)");
  if (actions.includes("voice.inject_audio")) return;
  if (actions.includes("voice.panel.open")) {
    await executeControl(client, "voice.panel.open");
    await waitFor(client, "window.__openworkControl.listActions().some((action) => action.id === 'voice.inject_audio')", 8000);
    return;
  }
  throw new Error(`Voice panel actions are not registered. Open a session and enable Voice Mode first. Voice actions: ${actions.filter((id) => id.startsWith("voice.")).join(", ")}`);
}

async function collectProof(client, expectedRoute) {
  const started = Date.now();
  let proof = null;
  while (true) {
    proof = await readProof(client);
    const routeMatched = expectedRoute && proof.href.includes(expectedRoute);
    const acted = proof.narration.includes("Done:") || proof.narration.includes("Running");
    if (routeMatched || (!expectedRoute && acted)) return { ...proof, elapsedMs: Date.now() - started };
    if (Date.now() - started >= 60000) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ...proof, elapsedMs: Date.now() - started, timedOut: true };
}

async function readProof(client) {
  return evaluate(client, `({
    href: location.href,
    narration: window.__openworkControl?.snapshot?.().narration ?? "",
    route: window.__openworkControl?.snapshot?.().route ?? "",
    bodyText: document.body.innerText.slice(-2400),
  })`);
}

async function executeControl(client, actionId, actionArgs = undefined) {
  const expression = `window.__openworkControl.execute(${JSON.stringify(actionId)}, ${JSON.stringify(actionArgs)})`;
  const result = await evaluate(client, expression, true);
  if (!result?.ok) throw new Error(`Control action failed: ${actionId}: ${result?.error ?? "unknown error"}`);
  return result;
}

async function synthesizePcm16Base64(input) {
  const ffmpeg = await requireCommand("ffmpeg", "ffmpeg is required for generated voice audio. On Daytona/Linux install it with: apt-get update && apt-get install -y ffmpeg espeak-ng");
  const tts = await findTtsCommand();
  const dir = await mkdtemp(join(tmpdir(), "openwork-voice-cdp-"));
  const source = join(dir, "speech.wav");
  const pcm = join(dir, "speech.pcm");

  try {
    if (tts.kind === "say") {
      const aiff = join(dir, "speech.aiff");
      await execFileAsync(tts.command, ["-v", "Samantha", "-o", aiff, input]);
      await execFileAsync(ffmpeg, ["-y", "-i", aiff, "-ac", "1", "-ar", "24000", "-f", "s16le", pcm]);
    } else {
      await execFileAsync(tts.command, ["-w", source, input]);
      await execFileAsync(ffmpeg, ["-y", "-i", source, "-ac", "1", "-ar", "24000", "-f", "s16le", pcm]);
    }
    return (await readFile(pcm)).toString("base64");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function findTtsCommand() {
  const say = await commandPath("say");
  if (say) return { kind: "say", command: say };
  const espeakNg = await commandPath("espeak-ng");
  if (espeakNg) return { kind: "espeak", command: espeakNg };
  const espeak = await commandPath("espeak");
  if (espeak) return { kind: "espeak", command: espeak };
  throw new Error("No TTS command found. On Daytona/Linux install one with: apt-get update && apt-get install -y espeak-ng ffmpeg");
}

async function requireCommand(command, message) {
  const found = await commandPath(command);
  if (!found) throw new Error(message);
  return found;
}

async function commandPath(command) {
  try {
    const { stdout } = await execFileAsync("which", [command]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function pickTarget(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/json/list`);
  if (!response.ok) throw new Error(`Could not list CDP targets: ${response.status}`);
  const targets = await response.json();
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const target = pages.find((page) => page.title === "OpenWork") ??
    pages.find((page) => page.url.includes("localhost") || page.url.includes("127.0.0.1") || page.url.includes("[::1]")) ??
    pages[0];
  if (!target) throw new Error("No CDP page target found.");
  return target;
}

function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    let opened = false;

    const rejectPending = (error) => {
      for (const callbacks of pending.values()) callbacks.reject(error);
      pending.clear();
    };

    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        close: () => socket.close(),
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((innerResolve, innerReject) => {
            pending.set(id, { resolve: innerResolve, reject: innerReject });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              innerReject(error);
            }
          });
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      const error = new Error("CDP websocket failed.");
      rejectPending(error);
      if (!opened) reject(error);
    });
    socket.addEventListener("close", () => {
      const error = new Error("CDP websocket closed.");
      rejectPending(error);
      if (!opened) reject(error);
    });
  });
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed.");
  return result.result?.value;
}

async function waitFor(client, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(client, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
