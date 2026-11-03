// A chosen tab, trusted user events, and a private guest-owned demonstration.
// Field values are used only by a bounded, ephemeral privacy filter.
// They never enter demonstration steps, persisted drafts, or model context.
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { demonstrationCommandSchema, demonstrationSchema } from "@openwork/types/browser-demonstration";
import { publicDestination } from "./chromium.mjs";

const WORLD = "openwork-browser-demonstration";
const BINDING = "__openworkDemonstrationEvent";
const MISSING_LABEL_NOTICE = "The selected information has no label. Explain how to locate it before saving.";
function privacyFilter() {
  const values = new Map();
  let bytes = 0, concealed = false;
  return {
    remember(value, sensitive = false) {
      if (!value || concealed) return false;
      if (values.has(value)) { if (sensitive && !values.get(value)) { values.set(value, true); return true; } return false; }
      if (value.length > 4096 || values.size >= 256 || bytes + value.length > 32768) { concealed = true; values.clear(); return true; }
      values.set(value, sensitive); bytes += value.length; return true;
    },
    conceal() { concealed = true; values.clear(); },
    redact(text) {
      if (concealed) return "[private]";
      let result = text;
      for (const [value, sensitive] of [...values].sort((a, b) => b[0].length - a[0].length)) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Short ordinary typing prefixes must not erase unrelated control labels.
        const pattern = !sensitive && value.length < 4 ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
        const expression = new RegExp(pattern, "giu");
        result = result.split(/(\[private\])/g).map(part => part === "[private]" ? part : part.replace(expression, "[private]")).join("");
      }
      return result;
    },
    snapshot() { return { values: [...values], concealed }; },
    clear() { values.clear(); bytes = 0; concealed = false; },
  };
}
function pageRecorder(makePrivacyFilter) {
  if (window.top !== window || globalThis.__openworkTeaching) return;
  let recording = false, picking = false, sequence = 0;
  const privacy = makePrivacyFilter();
  const controls = new WeakMap();
  const safeName = (element, controlText = false) => {
    let name = element.getAttribute("aria-label") || [...(element.labels || [])].map(label => label.textContent).join(" ") || (element.tagName === "INPUT" ? element.getAttribute("placeholder") : controlText ? element.textContent : "") || "";
    return privacy.redact(name).replace(/\s+/g, " ").trim().slice(0, 160);
  };
  const protectedField = element => element.matches('input[type="password"],input[type="hidden"],[autocomplete="one-time-code"],[autocomplete^="cc-"]') || /password|secret|token|otp|verification.?code|card.?number/i.test(`${element.getAttribute("name") || ""} ${element.getAttribute("autocomplete") || ""} ${element.getAttribute("aria-label") || ""}`);
  const collect = () => {
    if (!recording) return;
    for (const element of document.querySelectorAll("input,textarea,select")) {
      if (privacy.remember(element.value, protectedField(element))) {
        const snapshot = privacy.snapshot();
        // A separate private message feeds only the guest's in-memory filter.
        globalThis.__openworkDemonstrationEvent(JSON.stringify(snapshot.concealed ? { kind: "privacy", overflow: true } : { kind: "privacy", value: element.value, sensitive: protectedField(element) }));
      }
    }
  };
  const describe = (element, extraction = false) => {
    const tag = element.tagName.toLowerCase();
    let name = safeName(element, !extraction && element.matches('button,a,[role="button"],[role="link"]'));
    if (extraction && !element.hasAttribute("aria-label")) {
      const cell = element.closest("td"), term = element.closest("dd")?.previousElementSibling;
      const heading = cell?.closest("table")?.querySelectorAll("thead th")[cell.cellIndex];
      name = heading ? safeName(heading, true) : term?.tagName === "DT" ? safeName(term, true) : "";
    }
    return { tag, role: privacy.redact(element.getAttribute("role") || ({ a: "link", button: "button", input: "textbox", textarea: "textbox", select: "combobox", table: "table" }[tag] || "text")).slice(0, 60), name };
  };
  const emit = (kind, element, extra = {}) => {
    if (!recording) return;
    collect();
    if (protectedField(element) || element.closest('[contenteditable="true"]')) return;
    if (!controls.has(element)) controls.set(element, ++sequence);
    globalThis.__openworkDemonstrationEvent(JSON.stringify({ kind, control: controls.get(element), target: describe(element, kind === "extract"), ...extra }));
  };
  const click = event => {
    if (!event.isTrusted || !recording) return;
    const element = event.target instanceof Element ? event.target.closest('button,a,input,select,textarea,[role="button"],[role="link"]') || (picking ? event.target : null) : null;
    if (!element) return;
    if (picking) {
      event.preventDefault(); event.stopImmediatePropagation(); picking = false;
      emit("extract", element); return;
    }
    if (element.matches('input,textarea,select,label')) return;
    emit("click", element);
  };
  const preventActivation = event => {
    if (event.isTrusted && recording && picking) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const input = event => {
    if (!event.isTrusted || !(event.target instanceof Element) || !event.target.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),textarea')) return;
    emit("fill", event.target);
  };
  const change = event => {
    if (!event.isTrusted || !(event.target instanceof Element) || event.target.tagName !== "SELECT") return;
    emit("select", event.target);
  };
  const key = event => {
    if (!event.isTrusted || !recording || !(event.target instanceof Element)) return;
    if (event.key === "Escape" && picking) { picking = false; return; }
    if (["Enter", "Tab", "Escape"].includes(event.key)) emit("key", event.target, { key: event.key });
  };
  window.addEventListener("click", click, true);
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"]) window.addEventListener(type, preventActivation, true);
  window.addEventListener("beforeinput", collect, true);
  window.addEventListener("input", input, true);
  window.addEventListener("change", change, true);
  window.addEventListener("keydown", key, true);
  globalThis.__openworkTeaching = {
    set(active, pick = false, history = { values: [], concealed: false }) {
      for (const [value, sensitive] of history.values) privacy.remember(value, sensitive);
      if (history.concealed) privacy.conceal();
      recording = active; picking = active && pick; collect();
    },
    dispose() { recording = false; window.removeEventListener("click", click, true); for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup"]) window.removeEventListener(type, preventActivation, true); window.removeEventListener("beforeinput", collect, true); window.removeEventListener("input", input, true); window.removeEventListener("change", change, true); window.removeEventListener("keydown", key, true); privacy.clear(); delete globalThis.__openworkTeaching; },
  };
}
const SCRIPT = `(${pageRecorder.toString()})(${privacyFilter.toString()})`;

function connect(url, onEvent, onClose = () => {}) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("Browser connection timed out.")); socket.close(); }, 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser connection failed.")); }, { once: true });
  });
  void ready.catch(() => {});
  const close = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("The teaching tab disconnected. Reconnect to continue.")); } pending.clear(); };
  socket.addEventListener("close", () => { close(); onClose(); });
  socket.addEventListener("message", event => {
    let message; try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id) { onEvent(message); return; }
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error("The teaching tab changed. Inspect it before continuing.")); else item.resolve(message.result);
  });
  return {
    async send(method, params = {}) {
      await ready;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("The teaching tab did not respond.")); }, 5000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); close(); },
  };
}

export function createBrowserDemonstration({ path, endpoint = "http://127.0.0.1:9222", allowed = publicDestination, now = Date.now }) {
  let demo = null, owner = null, wire = null, scriptId = null, contextId = null, frameId = null;
  let lastField = null, connectionGeneration = 0;
  let until = 0, serial = Promise.resolve(), writing = Promise.resolve(), events = Promise.resolve(), loaded = false;
  const enqueue = work => { events = events.catch(() => {}).then(work).catch(() => {}); };
  const contexts = new Map();
  const privacy = privacyFilter();
  const active = () => demo?.phase === "recording" && now() < until;
  const persist = () => {
    const snapshot = JSON.stringify({ owner, demonstration: demo });
    writing = writing.catch(() => {}).then(async () => { await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 }); await rename(`${path}.tmp`, path); });
    return writing;
  };
  const append = (step, fieldKey = null) => {
    if (!active()) return;
    if (demo.steps.length >= 120) { demo.phase = "paused"; demo.notice = "120 steps recorded. Finish this skill or discard it and teach a smaller task."; void persist().catch(() => {}); return; }
    const previous = demo.steps.at(-1);
    if (step.kind === "fill" && previous?.kind === "fill" && fieldKey !== null && fieldKey === lastField) { previous.target = step.target; void persist().catch(() => {}); return; }
    lastField = step.kind === "fill" ? fieldKey : null;
    const id = (previous?.id ?? 0) + 1;
    const entry = { ...step, id, explanation: "", revision: 0 };
    if (["fill", "select"].includes(step.kind)) entry.parameter = `input_${id}`;
    if (step.kind === "extract") {
      entry.field = `field_${id}`;
      if (!step.target?.name) demo.notice = MISSING_LABEL_NOTICE;
    }
    demo.steps.push(entry); void persist().catch(() => {});
  };
  const navigation = async url => {
    if (!active()) return;
    const navigatedDemo = demo;
    let parsed; try { parsed = new URL(url); } catch { return; }
    if (!await allowed(url)) { demo.phase = "paused"; demo.notice = "The tab left the permitted browser destinations. Recording paused."; await persist(); return; }
    if (demo !== navigatedDemo || !active() || !["https:", "http:"].includes(parsed.protocol)) return;
    // Even a hostname can carry a bearer token. Addresses stay out of recordings;
    // the saved skill asks for a public entry URL as an input to each run.
    if (demo.steps.at(-1)?.kind !== "navigate") append({ kind: "navigate" });
  };
  const setMode = async (pick = false) => {
    if (wire && contextId !== null) await wire.send("Runtime.evaluate", { contextId, expression: `${SCRIPT}; globalThis.__openworkTeaching?.set(${active()}, ${pick}, ${JSON.stringify(privacy.snapshot())})` });
  };
  async function attach(target) {
    const address = new URL(target.webSocketDebuggerUrl);
    if (address.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(address.hostname) || address.port !== new URL(endpoint).port) throw new Error("Invalid browser endpoint.");
    const generation = ++connectionGeneration;
    wire = connect(address.href, event => {
      if (generation !== connectionGeneration) return;
      if (event.method === "Runtime.executionContextCreated") {
        const context = event.params.context;
        contexts.set(context.id, context);
        if (context.name === WORLD && context.auxData?.frameId === frameId) { contextId = context.id; void setMode().catch(() => {}); }
      }
      if (event.method === "Runtime.executionContextsCleared") { contexts.clear(); contextId = null; }
      if (event.method === "Page.frameNavigated" && !event.params.frame.parentId) {
        frameId = event.params.frame.id;
        enqueue(() => navigation(event.params.frame.url));
      }
      if (event.method !== "Runtime.bindingCalled" || event.params.name !== BINDING) return;
      const context = contexts.get(event.params.executionContextId);
      if (!active() || context?.name !== WORLD || context.auxData?.frameId !== frameId || event.params.payload.length > 25000) return;
      let value; try { value = JSON.parse(event.params.payload); } catch { return; }
      if (value.kind === "privacy") {
        if (value.overflow === true) privacy.conceal();
        else if (typeof value.value === "string" && typeof value.sensitive === "boolean") privacy.remember(value.value, value.sensitive);
        return;
      }
      if (event.params.payload.length > 2048 || !["click", "fill", "select", "key", "extract"].includes(value.kind)) return;
      if (value.target && typeof value.target === "object") for (const key of ["name", "role", "tag"]) if (typeof value.target[key] === "string") value.target[key] = privacy.redact(value.target[key]);
      const { control, ...data } = value;
      const parsed = demonstrationSchema.shape.steps.element.safeParse({ ...data, id: 1, explanation: "", ...(value.kind === "fill" || value.kind === "select" ? { parameter: "input_1" } : {}), ...(value.kind === "extract" ? { field: "field_1" } : {}) });
      if (parsed.success) { const { id, explanation, parameter, field, ...step } = parsed.data; enqueue(() => append(step, Number.isSafeInteger(control) ? `${event.params.executionContextId}:${control}` : null)); }
    }, () => {
      if (generation !== connectionGeneration) return;
      // The taught tab closed (the Browser view's tabs can close it) or the browser restarted: nothing more reaches
      // this recording, so say so instead of showing it as still recording.
      connectionGeneration++; wire = null; contextId = null; scriptId = null; contexts.clear();
      enqueue(async () => {
        if (demo?.phase !== "recording") return;
        demo.phase = "paused"; demo.notice = "The taught tab closed. Recording paused."; await persist();
      });
    });
    await wire.send("Runtime.enable"); await wire.send("Page.enable");
    const tree = await wire.send("Page.getFrameTree"); frameId = tree.frameTree.frame.id;
    await wire.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    const script = await wire.send("Page.addScriptToEvaluateOnNewDocument", { source: SCRIPT, worldName: WORLD }); scriptId = script.identifier;
    const context = await wire.send("Page.createIsolatedWorld", { frameId, worldName: WORLD }); contextId = context.executionContextId;
    await wire.send("Runtime.evaluate", { contextId, expression: SCRIPT }); await setMode();
  }
  async function detach() {
    if (!wire) return;
    connectionGeneration++;
    await wire.send("Runtime.evaluate", { contextId, expression: "globalThis.__openworkTeaching?.dispose()" }).catch(() => {});
    if (scriptId) await wire.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }).catch(() => {});
    wire.close(); wire = null; contextId = null; scriptId = null; contexts.clear();
  }
  async function tabs() {
    const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("The browser is unavailable.");
    const targets = await response.json();
    return targets.filter(target => target.type === "page").slice(0, 12);
  }
  // Teaching records one tab, so bring it to the front where the person is watching. Best effort: recording works anyway.
  const show = id => fetch(`${endpoint}/json/activate/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000), redirect: "error" }).then(response => response.body?.cancel(), () => {});
  async function command(sessionId, raw) {
    if (!loaded) {
      try {
        const saved = JSON.parse(await readFile(path, "utf8"));
        demo = demonstrationSchema.parse(saved.demonstration); owner = saved.owner;
        // Redaction history deliberately does not survive a process restart.
        if (demo.phase !== "draft") { demo.phase = "draft"; demo.notice = "Recording was interrupted. Review the captured steps or start a new demonstration."; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      loaded = true;
    }
    await events;
    if (owner && owner !== sessionId) throw new Error("This demonstration belongs to another conversation.");
    const input = demonstrationCommandSchema.parse(raw);
    if (input.action === "tabs") return { demonstration: demo, tabs: (await tabs()).map(target => ({ id: target.id, origin: new URL(target.url).origin })) };
    if (input.action === "start") {
      if (demo) throw new Error("Finish or discard the current demonstration first.");
      const target = (await tabs()).find(tab => tab.id === input.tabId);
      if (!target || !await allowed(target.url)) throw new Error("Choose a permitted browser tab.");
      privacy.clear(); owner = sessionId; until = now() + 12_000;
      demo = { id: randomUUID(), phase: "recording", tabId: target.id, steps: [] };
      try { await attach(target); await navigation(target.url); await show(target.id); } catch (error) { await detach(); privacy.clear(); demo = null; owner = null; throw error; }
    } else if (input.action === "discard") {
      await detach(); await writing; await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }); demo = null; owner = null; privacy.clear();
    } else if (demo) {
      if (demo.phase === "recording" && now() >= until) { demo.phase = "paused"; demo.notice = "Recording paused because the teaching connection expired."; await setMode(); }
      if (input.action === "pause" || input.action === "finish") {
        demo.phase = input.action === "finish" ? "draft" : "paused"; await setMode();
        if (input.action === "finish") { await detach(); privacy.clear(); }
      } else if (input.action === "resume") {
        if (demo.phase !== "paused") throw new Error("Only a paused demonstration can resume.");
        const target = (await tabs()).find(tab => tab.id === demo.tabId);
        if (!target || !await allowed(target.url)) throw new Error("The chosen tab is unavailable. Finish this skill or discard it.");
        demo.phase = "recording"; demo.notice = undefined; until = now() + 12_000;
        try { if (!wire) await attach(target); await setMode(); } catch (error) { demo.phase = "paused"; throw error; }
        await show(target.id);
      } else if (input.action === "pick") {
        if (!active()) throw new Error("Resume teaching before selecting information."); await setMode(true);
      } else if (input.action === "annotate") {
        const seen = demo.annotationIds ?? [];
        if (!input.messageId || !seen.includes(input.messageId)) {
          if (input.messageId && seen.length >= 256) throw new Error("Finish this demonstration before adding more notes.");
          let step = input.stepId ? demo.steps.find(step => step.id === input.stepId) : demo.steps.at(-1);
          if (!step && !input.stepId && demo.steps.length < 120) {
            step = { id: 1, kind: "note", explanation: "", revision: 0 }; demo.steps.push(step);
          }
          if (!step) throw new Error("Choose an available step before explaining it.");
          const explanation = `${step.explanation}${step.explanation ? "\n" : ""}${input.text}`;
          if (explanation.length > 2000) throw new Error("The step's notes are full. Edit its explanation before adding more.");
          step.explanation = explanation; step.revision = (step.revision ?? 0) + 1;
          if (input.messageId) demo.annotationIds = [...seen, input.messageId];
        }
      } else if (input.action === "edit") {
        const step = demo.steps.find(step => step.id === input.stepId);
        if (!step) throw new Error("The step is unavailable.");
        if (input.expectedRevision !== undefined && input.expectedRevision !== (step.revision ?? 0)) throw new Error("This step has newer notes. Review its current explanation before saving.");
        step.explanation = input.explanation; step.revision = (step.revision ?? 0) + 1;
        if (input.parameter && ["fill", "select"].includes(step.kind)) step.parameter = input.parameter;
        if (input.field && step.kind === "extract") step.field = input.field;
      }
      if (input.action === "read" && demo.phase === "recording") until = now() + 12_000;
    }
    if (demo?.notice === MISSING_LABEL_NOTICE && demo.steps.every(step => step.kind !== "extract" || step.target?.name || step.explanation.trim())) demo.notice = undefined;
    if (demo) await persist();
    return { demonstration: structuredClone(demo) };
  }
  return {
    isTeaching() { return demo !== null && demo.phase !== "draft"; },
    command(sessionId, input) { const result = serial.then(() => command(sessionId, input)); serial = result.catch(() => {}); return result; },
    async close() { await detach(); if (demo?.phase === "recording") { demo.phase = "paused"; await persist(); } await writing; privacy.clear(); },
  };
}
