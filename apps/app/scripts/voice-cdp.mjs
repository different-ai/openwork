const args = parseArgs(process.argv.slice(2));
const cdpUrl = args.cdpUrl ?? process.env.CDP_URL ?? "http://127.0.0.1:9825";
const mode = args.mode ?? "preflight";
const requireAudioPermission = args.requireAudioPermission === true;

async function main() {
  if (mode !== "preflight") throw new Error("Legacy transcript/audio injection was retired. Run pnpm evals:e2e voice-conversation for deterministic integration evidence, or use Start voice for a live microphone check.");
  const target = await pickTarget(cdpUrl);
  const client = await connectCdp(target.webSocketDebuggerUrl);

  try {
    await waitFor(client, "Boolean(window.__openworkControl)", 15000);
    console.log(JSON.stringify(await runPreflight(client), null, 2));
  } finally {
    client.close();
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--mode") parsed.mode = values[++index];
    else if (value === "--cdp-url") parsed.cdpUrl = values[++index];
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
  const media = requireAudioPermission
    ? await evaluate(client, `(${mediaPreflight.toString()})()`, true)
    : { audio: { checked: false }, video: { checked: false } };

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
