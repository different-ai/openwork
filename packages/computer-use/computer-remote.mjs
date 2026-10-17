// A remote computer (a Linux VM, a cloud desktop) as a computer use adapter.
// It speaks the same seven-tool contract as the macOS helper, so the broker,
// consent, handoff and the floating Computer view work unchanged. Providers
// supply only a small driver: windows, screenshots and input.
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { COMPUTER_PROTOCOL } from "./computer-control.mjs";

const SESSION_SECONDS = 900;
const OBSERVATION_MS = 60_000;
const MAX_ACTIONS = 200;
const FRAME_MS = 800;
const WATCH_MS = 1_500;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Region
 * @typedef {{ id: number, title: string, app: string, region: Region }} RemoteWindow
 * @typedef {{
 *   type: string, x?: number, y?: number, text?: string, key?: string, ms?: number,
 *   delta_x?: number, delta_y?: number, modifiers?: string[], path?: Array<{ x: number, y: number }>, ref?: string,
 * }} RemoteAction
 * @typedef {{
 *   platform: "linux",
 *   describe: () => Promise<{ readiness: "ready" | "setup-required" | "unavailable", detail: string }>,
 *   windows: () => Promise<RemoteWindow[]>,
 *   screen: () => Promise<Region>,
 *   focus: (windowId: number) => Promise<void>,
 *   screenshot: (region: Region, options?: { maxWidth?: number, windowId?: number }) => Promise<{ png: Uint8Array, width: number, height: number }>,
 *   interruptibleInput?: boolean,
 *   accessibility?: (region: Region, options: { observationId: string, windowId?: number }) => Promise<{ elements: Array<Record<string, unknown>>, capability: string, truncated?: boolean }>,
 *   input: (steps: RemoteAction[], options?: { windowId?: number, observationId?: string, signal?: AbortSignal }) => Promise<{ completed: number, error?: string }>,
 * }} ComputerDriver
 */

const text = (value, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] });
const failure = (code, message, extra = {}) => text({ ok: false, code, message, ...extra }, true);
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * @param {{ id: string, label: string, driver: ComputerDriver, now?: () => number }} options
 */
export function createRemoteComputerAdapter({ id, label, driver, now = Date.now }) {
  return {
    id,
    label,
    placement: /** @type {"remote"} */ ("remote"),
    protocol: COMPUTER_PROTOCOL,
    async readiness() {
      return driver.describe();
    },
    /** @param {{ signal: AbortSignal, onUi: (value: unknown) => void, onClose: () => void }} options */
    async connect({ signal, onUi, onClose }) {
      signal.throwIfAborted();
      let session = null;
      let closed = false;
      let queue = Promise.resolve();
      let inputSequence = 0;
      let frameSequence = 0;
      let watchUntil = 0;
      let frameTimer = null;
      let inputController = null;
      // Driver calls never overlap: frames, observations and input share one line.
      /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
      const serial = (work) => {
        const result = queue.then(work);
        queue = result.then(() => undefined, () => undefined);
        return result;
      };
      const publish = (value) => { if (!closed) onUi(value); };
      const publishState = (phase, extra = {}) => {
        if (!session) return;
        publish({ kind: "state", id: session.uiId, phase, appID: session.appId, appName: session.appName, mode: session.mode, task: session.purpose,
          ...(session.window ? { windowTitle: session.window.title } : {}), ...(phase === "paused" ? { canContinue: true } : {}), ...extra });
      };
      const expiresIn = () => session ? Math.max(0, Math.round((session.expiresAt - now()) / 1000)) : 0;
      const live = () => session && !session.closed && now() < session.expiresAt;
      const status = () => ({ ok: true, session_id: session.id, state: session.paused ? "paused" : "active", app_name: session.appName,
        ...(session.window ? { window_title: session.window.title } : {}), mode: session.mode, purpose: session.purpose, expires_in_seconds: expiresIn(),
        ...(session.paused ? { next: "human_takeover", pause_reason: "The person took over. Wait for them to choose Continue in the Computer view." } : {}) });

      async function refreshWindow() {
        const windows = await driver.windows();
        const match = windows.find((window) => window.id === session.window.id);
        if (!match) throw new Error("The approved window closed.");
        session.window = match;
        return match;
      }

      // Window captures use the selected drawable, never a crop of the root
      // screen, where an overlapping unapproved window could appear.
      async function captureWindow(region, options = {}) {
        const current = session;
        const generation = current.generation;
        const check = () => {
          if (closed || !live() || session !== current || current.generation !== generation || current.paused) throw new Error("The computer session ended or paused.");
        };
        check();
        const window = current.window;
        const shot = await driver.screenshot(window.whole ? region : { ...region, x: region.x - window.region.x, y: region.y - window.region.y },
          { ...options, ...(!window.whole ? { windowId: window.id } : {}) });
        check();
        return shot;
      }

      function scheduleFrames() {
        clearTimeout(frameTimer);
        if (closed || !live() || session.paused || !session.window || now() >= watchUntil) return;
        frameTimer = setTimeout(() => {
          void serial(async () => {
            if (closed || !live() || session.paused || now() >= watchUntil) return;
            if (!session.window.whole) await refreshWindow();
            const shot = await captureWindow(session.window.region, { maxWidth: 960 });
            publish({ kind: "frame", id: session.uiId, sequence: ++frameSequence, capturedAt: now(), width: shot.width, height: shot.height, mimeType: "image/png", data: base64(shot.png) });
          }).catch(() => {}).finally(scheduleFrames);
        }, FRAME_MS);
        frameTimer.unref?.();
      }

      function close(reason) {
        if (!session || session.closed) return;
        inputController?.abort(new Error("Computer input stopped."));
        session.closed = true;
        session.generation++;
        session.decide?.({ action: "deny" });
        publishState("closed", { status: reason });
        clearTimeout(frameTimer);
      }

      // Image pixels of an observation map back to screen pixels of its window.
      const toScreen = (observation, x, y) => ({
        x: observation.region.x + Math.min(observation.region.width - 1, Math.floor(x * observation.region.width / observation.width)),
        y: observation.region.y + Math.min(observation.region.height - 1, Math.floor(y * observation.region.height / observation.height)),
      });

      const within = (observation, point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)
        && point.x >= 0 && point.y >= 0 && point.x < observation.width && point.y < observation.height;
      async function verifyRegion(observation) {
        if (session.window.whole) return;
        const { region } = await refreshWindow();
        if (["x", "y", "width", "height"].some((key) => region[key] !== observation.region[key])) throw new Error("The approved window moved or resized. Observe again; nothing was dispatched.");
      }

      const tools = {
        async computer_discover() {
          const windows = await serial(() => driver.windows());
          const apps = new Map([["desktop", { app_id: "desktop", name: "Whole screen", windows: 1 }]]);
          for (const window of windows) {
            const entry = apps.get(window.app) ?? { app_id: window.app, name: window.app, windows: 0 };
            entry.windows++;
            apps.set(window.app, entry);
          }
          return text({ ok: true, protocol: COMPUTER_PROTOCOL, computer: label, platform: driver.platform, apps: [...apps.values()],
            modes: ["observe", "control"], permissions: { accessibility: true, screenRecording: true },
            keyboard: { modifiers: ["control", "shift", "option", "command"], note: "Linux: use control for shortcuts; command is sent as control, option as alt." },
            limits: { session_seconds: SESSION_SECONDS, actions: MAX_ACTIONS, batch: 8, observation_seconds: OBSERVATION_MS / 1000 },
            note: "Observations include semantic controls when AT-SPI is available. Otherwise use coordinates from the observation image." });
        },
        async computer_open_session(args, options) {
          if (live()) return failure("session_open", "A session is already open. Keep using it, or close it first. Nothing was dispatched.");
          if (!["observe", "control", "assist"].includes(args.mode) || typeof args.app_id !== "string" || !args.app_id || typeof args.purpose !== "string" || !args.purpose || args.purpose.length > 500) return failure("invalid_arguments", "Provide an app, mode and task purpose.");
          if (args.mode === "assist") return failure("mode_unsupported", "This computer has no accessibility controls. Use control (mouse and keyboard) or observe. Nothing was dispatched.");
          const windows = args.app_id === "desktop"
            ? [{ id: 1, title: "Whole screen", app: "desktop", region: await serial(() => driver.screen()), whole: true }]
            : (await serial(() => driver.windows())).filter((window) => window.app === args.app_id);
          options.signal.throwIfAborted();
          if (closed) throw new Error("Computer use ended while finding the app.");
          if (!windows.length) return failure("app_not_found", "That app has no open window on this computer. Call computer_discover again. Nothing was dispatched.");
          session = { id: randomUUID(), uiId: randomUUID(), appId: args.app_id, appName: args.app_id === "desktop" ? "Whole screen" : args.app_id, mode: args.mode,
            purpose: args.purpose, generation: 0, window: null, paused: false, closed: false, expiresAt: now() + SESSION_SECONDS * 1000, actions: 0,
            observations: new Map(), receipts: new Map(), decide: null };
          const current = session;
          // The broker selects the window automatically under the rollout.
          let abort;
          const decision = await new Promise((resolve, reject) => {
            current.decide = resolve;
            abort = () => reject(options.signal.reason);
            options.signal.addEventListener("abort", abort, { once: true });
            if (options.signal.aborted) { abort(); return; }
            publish({ kind: "state", id: current.uiId, phase: "approval", appID: current.appId, ...(args.pid ? { pid: args.pid } : {}), appName: current.appName,
              mode: current.mode, task: current.purpose, windows: windows.map(({ id, title }) => ({ id, title })) });
          }).finally(() => { current.decide = null; options.signal.removeEventListener("abort", abort); });
          options.signal.throwIfAborted();
          if (decision.action !== "approve" || current.closed) {
            session = null;
            return failure("access_denied", "The person did not approve a window. Nothing was dispatched. Do not retry unless they ask.");
          }
          current.window = windows.find((window) => window.id === decision.windowId);
          if (!current.window) { close("The window choice changed."); return failure("access_denied", "Choose a current window. Nothing was dispatched."); }
          if (!current.window.whole) await serial(() => driver.focus(current.window.id));
          options.signal.throwIfAborted();
          if (closed || current.closed) throw new Error("Computer use ended while opening the app.");
          publishState("working");
          return text({ ...status(), ok: true, state: "active" });
        },
        async computer_observe(args) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open. Call computer_open first.");
          if (session.paused) return text({ ...status(), ok: false, code: "paused" }, true);
          const window = session.window.whole ? session.window : await serial(refreshWindow);
          const shot = args.include_image === false ? { width: window.region.width, height: window.region.height, png: null } : await serial(() => captureWindow(window.region, { maxWidth: 1600 }));
          const observationId = randomUUID();
          const semantics = driver.accessibility ? await serial(() => driver.accessibility(window.region, { observationId, ...(!window.whole ? { windowId: window.id } : {}) })) : { elements: [], capability: "unavailable" };
          const scaleX = shot.width / window.region.width, scaleY = shot.height / window.region.height;
          const elements = semantics.elements.map((element) => {
            const bounds = element.bounds;
            return { ...element, ...(bounds && typeof bounds === "object" && "x" in bounds && "y" in bounds && "width" in bounds && "height" in bounds ? { bounds: { x: Number(bounds.x) * scaleX, y: Number(bounds.y) * scaleY, width: Number(bounds.width) * scaleX, height: Number(bounds.height) * scaleY } } : {}) };
          });
          session.observations.set(observationId, { at: now(), region: window.region, scale: window.region.width / shot.width, width: shot.width, height: shot.height, hasImage: args.include_image !== false });
          for (const key of [...session.observations.keys()].slice(0, -8)) session.observations.delete(key);
          return { content: [
            { type: "text", text: JSON.stringify({ ok: true, observation_id: observationId, width: shot.width, height: shot.height, window_title: window.title,
              elements, accessibility: semantics.capability, truncated: semantics.truncated === true, expires_in_seconds: OBSERVATION_MS / 1000, note: "Coordinates are image pixels of this observation." }) },
            ...(args.include_image === false ? [] : [{ type: "image", data: base64(shot.png), mimeType: "image/png" }]),
          ] };
        },
        async computer_zoom(args, options) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open. Call computer_open first.");
          const observation = session.observations.get(args.observation_id);
          if (!observation || now() - observation.at > OBSERVATION_MS) return failure("observation_expired", "Observe again before zooming.");
          if (session.paused) return failure("paused", "The person has control. Wait for Continue.");
          if (!within(observation, args) || !Number.isFinite(args.width) || !Number.isFinite(args.height) || args.width <= 0 || args.height <= 0
            || args.x + args.width > observation.width || args.y + args.height > observation.height) return failure("out_of_bounds", "Zoom must stay inside the approved observation. Nothing was captured.");
          const start = toScreen(observation, args.x, args.y);
          const region = { x: start.x, y: start.y,
            width: Math.min(observation.region.x + observation.region.width - start.x, Math.max(1, Math.floor(args.width * observation.region.width / observation.width))),
            height: Math.min(observation.region.y + observation.region.height - start.y, Math.max(1, Math.floor(args.height * observation.region.height / observation.height))) };
          const shot = await serial(async () => {
            options.signal.throwIfAborted();
            if (!live() || session.paused || closed) throw new Error("The computer session ended or paused.");
            await verifyRegion(observation);
            return captureWindow(region);
          });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, observation_id: args.observation_id, width: shot.width, height: shot.height }) }, { type: "image", data: base64(shot.png), mimeType: "image/png" }] };
        },
        async computer_act(args, options) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open. Call computer_open first.");
          if (session.paused) return text({ ...status(), ok: false, code: "paused" }, true);
          if (session.mode === "observe") return failure("mode_unsupported", "This session can only observe. Close it and open one in control mode.");
          // At most once: a repeated request returns its first receipt.
          if (typeof args.request_id !== "string" || !args.request_id || args.request_id.length > 256) return failure("invalid_arguments", "A bounded request identity is required.");
          const input = { observation_id: args.observation_id, action: args.action, actions: args.actions };
          const previous = session.receipts.get(args.request_id);
          if (previous) return isDeepStrictEqual(previous.input, input) ? previous.receipt : failure("request_conflict", "This request identity already belongs to different input. Nothing was dispatched.");
          const observation = session.observations.get(args.observation_id);
          if (!observation || now() - observation.at > OBSERVATION_MS) return failure("observation_expired", "That observation expired. Observe again; nothing was dispatched.");
          const actions = args.actions ?? [args.action];
          if (!Array.isArray(actions) || actions.length < 1 || actions.length > 8 || actions.some((action) => !action || typeof action !== "object" || !["move", "click", "double_click", "triple_click", "scroll", "drag", "type", "key", "wait", "press", "set_value"].includes(action.type)
            || action.type === "type" && (typeof action.text !== "string" || !action.text || action.text.length > 8000)
            || ["press", "set_value"].includes(action.type) && (!driver.accessibility || typeof action.ref !== "string" || action.ref.length > 256)
            || action.type === "set_value" && (typeof action.text !== "string" || action.text.length > 8000)
            || action.type === "key" && (typeof action.key !== "string" || !action.key)
            || action.modifiers !== undefined && (!Array.isArray(action.modifiers) || action.modifiers.some((modifier) => !["control", "command", "shift", "option"].includes(modifier))))) return failure("invalid_arguments", "Provide one to eight supported actions with valid input. Nothing was dispatched.");
          if (observation.hasImage === false && actions.some((action) => ["move", "click", "double_click", "triple_click", "scroll", "drag"].includes(action.type))) return failure("image_required", "Coordinate input needs an image observation. Nothing was dispatched.");
          if (session.actions + actions.length > MAX_ACTIONS) return failure("action_limit", "This session reached its action limit. Close it and open a new one.");
          if (actions.some((action) => !action || (action.x !== undefined || action.y !== undefined || ["move", "click", "double_click", "triple_click", "scroll"].includes(action.type)) && !within(observation, action)
            || action.path !== undefined && (!Array.isArray(action.path) || action.path.length < 2 || action.path.some((point) => !within(observation, point)))
            || action.type === "drag" && !action.path)) return failure("out_of_bounds", "Every input point must stay inside the approved observation. Nothing was dispatched.");
          const inputPoint = (x, y) => {
            const point = toScreen(observation, x, y);
            return session.window.whole ? point : { x: point.x - observation.region.x, y: point.y - observation.region.y };
          };
          const steps = actions.map((action) => {
            const point = action.x !== undefined && action.y !== undefined ? inputPoint(action.x, action.y) : null;
            return { ...action, ...(point ?? {}), ...(action.path ? { path: action.path.map((step) => inputPoint(step.x, step.y)) } : {}) };
          });
          const current = session;
          const generation = current.generation;
          const active = () => !closed && live() && session === current && !current.paused && current.generation === generation && !options.signal.aborted;
          const entry = { input: structuredClone(input), receipt: failure("dispatch_uncertain", "Input is in flight or was interrupted. Observe before continuing.") };
          current.receipts.set(args.request_id, entry);
          current.observations.delete(args.observation_id);
          current.actions += actions.length;
          /** @type {{ completed: number, attempted: boolean, error?: string }} */
          const progress = { completed: 0, attempted: false };
          const result = await serial(async () => {
            if (!active()) throw new Error("The computer session ended or paused.");
            await verifyRegion(observation);
            if (!active()) throw new Error("The computer session ended or paused.");
            if (!current.window.whole) await driver.focus(current.window.id);
            if (!active()) throw new Error("The computer session ended or paused before input.");
            if (driver.interruptibleInput) {
              inputController = new AbortController();
              progress.attempted = true;
              try {
                const result = await driver.input(steps, { ...(current.window.whole ? {} : { windowId: current.window.id }), observationId: args.observation_id, signal: AbortSignal.any([options.signal, inputController.signal]) });
                return { completed: result.completed, attempted: true, ...(result.error ? { error: result.error } : {}) };
              } finally { inputController = null; }
            }
            for (const action of steps) {
              // A remote command already in flight may settle, but no later
              // action (or text chunk) starts after takeover, stop or abort.
              const characters = action.type === "type" ? Array.from(action.text ?? "") : [];
              const chunks = characters.length ? Array.from({ length: Math.ceil(characters.length / 32) }, (_, index) => ({ ...action, text: characters.slice(index * 32, (index + 1) * 32).join("") })) : [action];
              for (const chunk of chunks) {
                if (!active()) return { ...progress, error: "Computer use paused or stopped before the remaining input." };
                progress.attempted = true;
                const result = await driver.input([chunk], current.window.whole ? {} : { windowId: current.window.id });
                if (result.completed !== 1) return { ...progress, error: result.error ?? "The window refused input." };
              }
              progress.completed++;
            }
            return progress;

          }).catch((error) => ({ ...progress, error: error instanceof Error ? error.message : "Input was interrupted." }));
          for (const action of actions.slice(0, result.completed)) {
            const x = action.x !== undefined ? action.x / observation.width : action.path?.at(-1) ? action.path.at(-1).x / observation.width : undefined;
            const y = action.y !== undefined ? action.y / observation.height : action.path?.at(-1) ? action.path.at(-1).y / observation.height : undefined;
            publish({ kind: "input", id: current.uiId, sequence: ++inputSequence, at: now(), action: action.type === "wait" ? "move" : action.type, phase: "dispatched",
              ...(x !== undefined && x >= 0 && x <= 1 ? { x } : {}), ...(y !== undefined && y >= 0 && y <= 1 ? { y } : {}) });
          }
          const receipt = result.completed === actions.length
            ? text({ ok: true, status: "dispatched", completed: actions.length, next: "observe" })
            : text({ ok: true, status: "partial", completed: result.completed, failed: result.completed, skipped: actions.length - result.completed - 1,
              may_have_acted: result.attempted, next: "observe", message: result.error ?? "A step failed." });
          entry.receipt = receipt;
          return receipt;
        },
        async computer_session_status(args) {
          if (!live() || args.session_id !== session.id) return failure("session_unavailable", "No session is open.");
          return text(status());
        },
        async computer_close_session(args) {
          if (!session || args.session_id !== session.id) return failure("session_unavailable", "No session is open.");
          close("Closed by the agent.");
          session = null;
          return text({ ok: true, state: "closed" });
        },
      };

      return {
        async callTool(name, args, options = {}) {
          if (closed) throw new Error(`${label} is disconnected.`);
          const tool = Object.hasOwn(tools, name) ? tools[name] : null;
          if (!tool) return failure("unknown_tool", "This computer tool does not exist.");
          const callSignal = options.signal ?? new AbortController().signal;
          try {
            return await tool(args ?? {}, { signal: callSignal });
          } catch (error) {
            if (callSignal.aborted) throw error;
            return failure("computer_failed", `${label} could not complete this: ${error instanceof Error ? error.message : String(error)}. Do not replay input; observe first.`);
          }
        },
        /** @param {{ id?: unknown, action?: unknown, windowId?: unknown, visible?: unknown }} params */
        async notifyUi({ id: uiId, action, windowId, visible }) {
          if (!session || session.uiId !== uiId) return;
          if (action === "approve" || action === "deny") { session.decide?.({ action, windowId }); return; }
          if (action === "watch") { watchUntil = visible ? now() + WATCH_MS : 0; scheduleFrames(); return; }
          if (action === "takeover" && !session.paused) { inputController?.abort(new Error("The person took over.")); session.generation++; session.paused = true; session.observations.clear(); publishState("paused"); return; }
          if (action === "resume" && session.paused) { session.generation++; session.paused = false; session.observations.clear(); publishState("working"); return; }
          if (action === "stop") close("Stopped by the person.");
        },
        async close() {
          if (closed) return;
          close("Computer use ended.");
          closed = true;
          clearTimeout(frameTimer);
          await queue;
          onClose();
        },
      };
    },
  };
}
