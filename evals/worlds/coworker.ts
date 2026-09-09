/**
 * Arrangement for the Open Coworker journeys.
 *
 * The specs observe the packaged app through `coworker()`. What they need
 * built beforehand — a standard MCP App page compiled the way OpenWork
 * Connect compiles one — is arranged here, so a spec never imports product
 * source and the boundary between witness and product stays visible.
 */
import type { GeneratedArtifactViewBuildInput } from "../../ee/apps/den-api/src/generated-artifact-view-builder.js";
import { addInitScript, browserScript, clickAt, evaluate, evaluateOnSurface, pressKey, waitForLocated, type Surface, type Target } from "@openwork/cdp";
import { coworker } from "@openwork/hosts";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StandardAppSource = GeneratedArtifactViewBuildInput;

/** The HTML of one standard MCP App view, compiled by the builder OpenWork Connect ships. */
export async function buildStandardAppHtml(source: StandardAppSource): Promise<string> {
  const builder = await import("../../ee/apps/den-api/src/generated-artifact-view-builder.js");
  const built = await builder.buildGeneratedArtifactViewInWorker(source);
  if (!built.ok) throw new Error(`Standard MCP App build failed: ${JSON.stringify(built.diagnostics)}`);
  return built.html;
}

/** Unlike the legacy DOM-click helpers, these events reach the preload's user-activation gate. */
export async function clickCoworkerControl(app: Surface, target: Target): Promise<void> {
  await app.client.send("Page.bringToFront");
  const found = await waitForLocated(app, target, { mustHitTest: true, timeoutMs: 30_000 }).catch(async (error) => {
    console.warn("Coworker control diagnostics", await evaluateOnSurface(app, browserScript((testId) =>
      [...document.querySelectorAll<HTMLElement>("[data-testid]")].filter((node) => node.dataset.testid === testId).map((node) => {
        const ancestors = [];
        for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          ancestors.push({ tag: parent.tagName, id: parent.dataset.testid, classes: parent.className, display: style.display, visibility: style.visibility, opacity: style.opacity, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        }
        return ancestors;
      }), [typeof target === "object" ? target.testId : ""] )));
    throw error;
  });
  await clickAt(app, found.center);
}

export async function typeCoworkerSpace(app: Surface): Promise<void> {
  await pressKey(app, process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
}

/** The account journey never inherits a provider, engine database, or Coworker home. */
export async function isolatedAccountCoworker(name: string, denBaseUrl: string, fakeMicrophone = false) {
  const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-account-"));
  const cleared = Object.fromEntries(Object.keys(process.env).filter((key) => /^(OPENCODE_|COWORKER_)/.test(key) || /(_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN)$/.test(key)).map((key) => [key, ""]));
  try {
    const app = await coworker({ name, profileDir, env: {
      ...cleared,
      COWORKER_DEN_BASE_URL: denBaseUrl,
      COWORKER_HOME_DIR: join(profileDir, "coworkers"),
      COWORKER_USER_DATA_DIR: join(profileDir, "electron-userdata"),
      COWORKER_SERVER_CONFIG: join(profileDir, "coworker-server.json"),
      OPENWORK_RUNTIME_DB: join(profileDir, "runtime.sqlite"),
      OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"),
      OPENWORK_SERVER_LOG_FILE: join(profileDir, "server.log"),
      OPENWORK_SERVER_URL: "",
      OPENWORK_SERVER_TOKEN: "",
      OPENWORK_POLICY_TOKEN: "",
      OPENWORK_UI_CONTROL_DISCOVERY: "",
      OPENWORK_OPENCODE_BIN: "",
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"),
      OPENCODE_DB: join(profileDir, "opencode.db"),
      CODEX_HOME: join(profileDir, "codex"),
      // Fake device only: the native consent and preload gesture gates remain real.
      ELECTRON_EXTRA_LAUNCH_ARGS: fakeMicrophone ? "--use-fake-device-for-media-stream" : "",
    } });
    return { ...app, async [Symbol.asyncDispose]() {
      await app.stop();
      await rm(profileDir, { recursive: true, force: true });
    } };
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

/** Destructive proof owns every storage path and refuses an implicit SDK install. */
export async function isolatedFreshStartCoworker(modelUrl: string, previewOnly = false) {
  const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-fresh-start-"));
  const owned = join(profileDir, "owned");
  const cleared = Object.fromEntries(Object.keys(process.env).filter((key) =>
    /^(OPENWORK_|OPENCODE_|COWORKER_|ELECTRON_|CODEX_|CLAUDE_)/.test(key)
    || /(_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN)$/.test(key)).map((key) => [key, ""]));
  try {
    await mkdir(owned, { recursive: true });
    const sdk = process.env.OPENWORK_EVAL_COWORKER_SDK_DIRECTORY;
    if (!previewOnly && !sdk) throw new Error("Native reset proof cannot launch without installing: provide OPENWORK_EVAL_COWORKER_SDK_DIRECTORY containing the already-cached engine SDK (node_modules/@opencode-ai/plugin). No app was started.");
    // The supplementary design preview exercises the real app's unavailable-engine
    // path. It cannot run a model or install the engine SDK and never attempts reset.
    const binary = previewOnly ? join(profileDir, "unavailable-opencode") : process.env.OPENWORK_EVAL_COWORKER_OPENCODE_BINARY || "opencode";
    const env = {
      ...process.env, ...cleared, HOME: join(profileDir, "home"),
      XDG_CONFIG_HOME: join(profileDir, "xdg-config"), XDG_DATA_HOME: join(profileDir, "xdg-data"),
      XDG_CACHE_HOME: join(profileDir, "xdg-cache"), XDG_STATE_HOME: join(profileDir, "xdg-state"),
      OPENCODE_DB: join(profileDir, "opencode.db"),
    };
    if (!previewOnly && sdk) {
      const version = (await promisify(execFile)(binary, ["--version"], { env, timeout: 10_000 })).stdout.trim();
      const manifest: unknown = JSON.parse(await readFile(join(sdk, "node_modules/@opencode-ai/plugin/package.json"), "utf8"));
      if (!manifest || typeof manifest !== "object" || !("version" in manifest) || manifest.version !== version) throw new Error(`Cached SDK does not match engine ${version}; no install or app launch was attempted.`);
      for (const directory of [join(profileDir, "xdg-config/opencode"), join(profileDir, "opencode-config")]) {
        await mkdir(directory, { recursive: true });
        await cp(join(sdk, "node_modules"), join(directory, "node_modules"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
      }
    }
    await writeFile(join(profileDir, "credential-sentinel.json"), JSON.stringify({ key: "UNRELATED-FIXTURE-CREDENTIAL" }), { mode: 0o600 });
    const repoRoot = new URL("../../", import.meta.url).pathname;
    const sourceFiles = [
      ...(await readdir(join(repoRoot, "apps/coworker/electron"))).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && !name.endsWith(".fixture.mjs")).map((name) => `apps/coworker/electron/${name}`),
      "apps/coworker/dist/index.html",
      ...(await readdir(join(repoRoot, "apps/coworker/dist/assets"))).filter((name) => /\.(js|css)$/.test(name)).map((name) => `apps/coworker/dist/assets/${name}`),
      "evals/worlds/coworker.ts", "evals/specs/open-coworker-local-first.e2e.test.ts",
      "evals/packages/hosts/src/coworker.ts", "evals/packages/hosts/src/local.ts",
    ];
    const files = Object.fromEntries(await Promise.all(sourceFiles.sort().map(async (file) => [file, createHash("sha256").update(await readFile(join(repoRoot, file))).digest("hex")])));
    const head = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    await writeFile(join(profileDir, "source-fingerprint.json"), JSON.stringify({ head, files }, null, 2), { mode: 0o600 });
    const app = await coworker({ name: "fresh-start", profileDir, env: {
      ...cleared,
      OPENWORK_EVAL_ELECTRON_ENTRY: new URL("../../apps/coworker/electron/main.mjs", import.meta.url).pathname,
      COWORKER_USER_DATA_DIR: join(owned, "electron-userdata"),
      COWORKER_HOME_DIR: join(owned, "coworkers"),
      COWORKER_SERVER_CONFIG: join(owned, "coworker-server.json"),
      OPENWORK_RUNTIME_DB: join(owned, "coworker-runtime.sqlite"),
      OPENWORK_ENV_STORE: join(owned, "coworker-env.json"),
      OPENWORK_DATA_DIR: join(profileDir, "openwork-data"),
      OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"),
      OPENWORK_SERVER_LOG_FILE: join(profileDir, "server.log"),
      OPENWORK_OPENCODE_BIN: binary,
      OPENWORK_DEV_MODE: "1", OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
      OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
      COWORKER_DEN_BASE_URL: modelUrl,
      OPENCODE_DB: join(profileDir, "opencode.db"),
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"),
      CODEX_HOME: join(profileDir, "codex"), CLAUDE_CONFIG_DIR: join(profileDir, "claude"),
      OLLAMA_HOST: "127.0.0.1:9", LMSTUDIO_HOST: "127.0.0.1:9",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_INSTALL: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["eval-reset"], provider: {
        "eval-reset": { npm: "@ai-sdk/openai-compatible", name: "Reset fixture", options: { baseURL: `${modelUrl}/v1`, apiKey: "fixture-only" }, models: { "stub-small": { name: "Reset fixture", tool_call: true } } },
      } }),
    } });
    const invoke = (command: string, payload: unknown = {}) => evaluate(app.client,
      browserScript((command, payload) => window.__COWORKER__.invoke(command, payload), [command, payload]),
      { awaitPromise: true, timeoutMs: 90_000 });
    const history = () => {
      const db = new DatabaseSync(join(profileDir, "opencode.db"), { readOnly: true });
      try { return db.prepare("SELECT id, directory FROM session ORDER BY id").all(); }
      finally { db.close(); }
    };
    const credentials = async () => {
      const nativeAuth: unknown = JSON.parse(await readFile(join(profileDir, "xdg-data/opencode/auth.json"), "utf8"));
      const db = new DatabaseSync(join(profileDir, "opencode.db"), { readOnly: true });
      try { return { database: db.prepare("SELECT * FROM credential").all(), nativeAuth }; }
      finally { db.close(); }
    };
    const seedUnrelatedHistory = () => {
      const db = new DatabaseSync(join(profileDir, "opencode.db"));
      try {
        const row = db.prepare("SELECT * FROM session LIMIT 1").get();
        if (!row) throw new Error("Create a real conversation before seeding the unrelated history control.");
        const other = { ...row, id: "ses_fresh_start_unrelated", directory: join(profileDir, "unrelated-project"), parent_id: null, slug: "fresh-start-unrelated" };
        const columns = Object.keys(other);
        db.prepare(`INSERT INTO session (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(other));
      } finally { db.close(); }
    };
    return { app, profileDir, invoke, history, credentials, seedUnrelatedHistory, async [Symbol.asyncDispose]() {
      await app.stop();
      // Retain this disposable reset receipt, backup, and log for diagnosis.
      console.log(`Isolated Fresh start receipt root: ${profileDir}`);
    } };
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

// Three independent MP3 frames repeated for 2.16 seconds (660 Hz tone, not speech).
// ffmpeg -f lavfi -i sine=frequency=660:sample_rate=8000:duration=0.072 -c:a libmp3lame -b:a 8k -reservoir 0 -write_xing 0 -id3v2_version 0 -f mp3
export const voiceMp3 = Buffer.concat(Array.from({ length: 10 }, () => Buffer.from(
  "/+MYxAAMgAbeWUEAApJJCKNtgBg+D4P4IAg6XB8/ggCH2A+D5/ggc/5cENQJn8Tgg6oEw/kwQ1AM/pDHL+7pTEFNRTMuMTAw"
  + "/+MYxAAOEPaoAYbIAKo6f/7vYkjRL/+MuyRpEA//7EZNQ8kMFlRa5rX0M4CECKa9nTwgZuSbi8zLaXK1W2d5QMZURBUFUxBA"
  + "/+MYxAAOuO6cAcwQAZta1rWtata1rWta2ta1rWtata1rVlatXLly46MhCBICRNYJQNgbA2EYnGQCAgICAgoKFBQUFBIKCgoK", "base64")));

/** Read-result shapes at the native IPC type boundary; never installs or replaces the bridge. */
export interface CoworkerTestBridge {
  invoke(command: "runtime.info"): Promise<{ ok: boolean; result: { serverUrl: string; ownerToken: string } }>;
  invoke(command: "coworkers.get", payload: { slug: string }): Promise<{ ok: boolean; result: { model: string; workspaceId: string } }>;
  invoke(command: "coworkers.list"): Promise<{ ok: boolean; result: Array<{ slug: string; name: string; model: string; automations: unknown[] }> }>;
  invoke(command: "coworkers.files.read", payload: { slug: string; path: string }): Promise<{ ok: boolean; result: { content: string } }>;
  invoke(command: string, payload?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    __coworkerVoiceCapture: {
      calls: number;
      tracks: MediaStreamTrack[];
      clicks: Array<{ control: string; trusted: boolean; active: boolean }>;
      playback: Array<{ node: AudioBufferSourceNode; context: AudioContext; started: number | null; ended: number | null; stopped: boolean; disconnected: boolean; destination: boolean }>;
    };
  }
}

/** Observe real capture; do not replace the bridge, grant permissions, or fabricate a stream. */
export async function observeCoworkerVoice(app: Surface) {
  function install() {
    const witness: Window["__coworkerVoiceCapture"] = { calls: 0, tracks: [], clicks: [], playback: [] };
    window.__coworkerVoiceCapture = witness;
    document.addEventListener("click", (event) => {
      const control = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-testid^="voice-"]') : null;
      if (control?.dataset.testid) witness.clicks.push({ control: control.dataset.testid, trusted: event.isTrusted, active: navigator.userActivation.isActive });
    }, true);
    if (navigator.mediaDevices?.getUserMedia) {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        witness.calls++;
        const stream = await capture(constraints);
        witness.tracks.push(...stream.getTracks());
        return stream;
      };
    }
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = createSource.call(this);
      const entry: Window["__coworkerVoiceCapture"]["playback"][number] = { node, context: this, started: null, ended: null, stopped: false, disconnected: false, destination: false };
      witness.playback.push(entry);
      const start = node.start.bind(node);
      const stop = node.stop.bind(node);
      const connect = node.connect.bind(node);
      const disconnect = node.disconnect.bind(node);
      node.start = (...args) => { start(...args); entry.started = this.currentTime; };
      node.stop = (...args) => { stop(...args); entry.stopped = true; };
      // The product connects a BufferSource to this context's real destination.
      node.connect = ((destination: AudioNode) => { entry.destination = destination === this.destination; return connect(destination); }) as typeof node.connect;
      node.disconnect = () => { disconnect(); entry.disconnected = true; };
      node.addEventListener("ended", () => { entry.ended = this.currentTime; }, { once: true });
      return node;
    };
  }
  const registration = await addInitScript(app.client, install);
  await evaluateOnSurface(app, install);
  return {
    read: () => evaluateOnSurface(app, () => ({
      calls: window.__coworkerVoiceCapture.calls,
      tracks: window.__coworkerVoiceCapture.tracks.map((track) => ({ kind: track.kind, state: track.readyState })),
      clicks: window.__coworkerVoiceCapture.clicks,
      playback: window.__coworkerVoiceCapture.playback.map(({ node, context, started, ended, stopped, disconnected, destination }) => ({
        started, ended, stopped, disconnected, destination, state: context.state,
        progress: started === null ? 0 : context.currentTime - started,
        duration: node.buffer?.duration ?? 0,
        hasSignal: node.buffer?.getChannelData(0).some((value) => Math.abs(value) > 0.001) ?? false,
      })),
      supported: Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined"
        && ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"].some((mime) => MediaRecorder.isTypeSupported(mime)),
      // Native Node fetch is not a renderer resource. A direct renderer voice request is a regression.
      rendererVoiceRequests: performance.getEntriesByType("resource").filter((entry) => /\/v1\/voice(?:\/|$)/.test(entry.name)).length,
    })),
    [Symbol.asyncDispose]: () => registration.dispose(),
  };
}
