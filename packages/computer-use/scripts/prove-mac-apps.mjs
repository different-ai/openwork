// Drives real Mac apps through the running OpenWork desktop, the same way the
// agent does: the desktop's local bridge, its broker and its signed helper.
// No model is involved, so each scenario has a fixed plan and checks a real
// outcome (Calculator's display, a file saved on disk). Every call is timed.
//
//   node packages/computer-use/scripts/prove-mac-apps.mjs [--only a,b] [--json out.json]
//
// Needs: a signed OpenWork desktop running on this Mac with computer use on and
// its macOS permissions granted, and no chat using the computer. It takes over
// the Mac for about a minute; leave the mouse and keyboard alone meanwhile.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const CALCULATOR = "com.apple.calculator";
const TEXTEDIT = "com.apple.TextEdit";

function option(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

/** The desktop's bridge, found the way the engine finds it. Loopback only; the token is never printed. */
async function bridge() {
  const explicit = process.env.OPENWORK_UI_CONTROL_DISCOVERY?.trim();
  const base = join(homedir(), "Library", "Application Support");
  const candidates = explicit ? [explicit] : [join(base, "com.differentai.openwork", "openwork-ui-control.json"), join(base, "com.differentai.openwork.dev", "openwork-ui-control.json")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      const url = new URL(parsed.baseUrl);
      if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && typeof parsed.token === "string") return { baseUrl: parsed.baseUrl, token: parsed.token, discovery: candidate };
    } catch { /* Try the next desktop. */ }
  }
  return null;
}

/** The running desktop's bundle and version, for the report and to bring it to the front. */
async function desktopVersion() {
  try {
    const { stdout: pids } = await run("/usr/bin/pgrep", ["-x", "OpenWork"]);
    for (const pid of pids.split("\n").filter(Boolean)) {
      const { stdout } = await run("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "txt", "-Fn"]);
      const executable = stdout.split("\n").find((line) => /^n.*\.app\/Contents\/MacOS\/OpenWork$/.test(line))?.slice(1);
      if (!executable) continue;
      const bundle = executable.slice(0, executable.indexOf("/Contents/MacOS/"));
      const { stdout: version } = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")]);
      return { bundle, version: version.trim() };
    }
  } catch { /* Reported as unknown. */ }
  return null;
}

/** A locked Mac hides every window from the helper, which would read as app failures. */
async function screenLocked() {
  try {
    const { stdout } = await run("/usr/sbin/ioreg", ["-n", "Root", "-d1"]);
    return /"CGSSessionScreenIsLocked"=Yes/.test(stdout);
  } catch {
    return false;
  }
}

const states = (body) => (body.content ?? []).filter((part) => part.type === "text").map((part) => {
  try { return JSON.parse(part.text); } catch { return { text: part.text }; }
});

/** One scenario's chat: a fresh session id, every call timed and recorded. */
function chat(desktop, scenario) {
  const sessionId = `mac-apps-check-${scenario}-${Date.now()}`;
  const steps = [];
  const seen = { last: null };
  async function call(name, args = {}) {
    const started = performance.now();
    const response = await fetch(`${desktop.baseUrl}/computer/task`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${desktop.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, sessionId }),
    });
    const body = await response.json();
    const parts = states(body);
    const first = parts[0] ?? {};
    const ok = body.isError !== true && first.ok !== false;
    const step = { tool: name, ms: Math.round(performance.now() - started), ok, ...(ok ? {} : { code: first.code ?? `http_${response.status}`, message: first.message }),
      // Actions report how input was delivered and whether the front app, cursor or Space changed.
      ...(first.desktop ? { delivery: first.delivery, desktop: first.desktop } : {}) };
    steps.push(step);
    const observation = parts.findLast((part) => typeof part.observation_id === "string");
    if (observation) seen.last = observation;
    return { ok, first, parts, observation };
  }
  return { sessionId, steps, seen, call };
}

/** What the last observation showed, so a failure says which window and controls the agent saw. */
function describe(observation) {
  if (!observation) return "no observation";
  const roles = {};
  for (const element of observation.elements ?? []) roles[element.role] = (roles[element.role] ?? 0) + 1;
  const top = Object.entries(roles).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([role, count]) => `${role}×${count}`).join(", ");
  const gaps = [
    observation.truncated ? `accessibility read incomplete${observation.privacy_issue ? ` (${observation.privacy_issue})` : ""}` : null,
    observation.image?.included === false && observation.image?.unavailable ? `no screenshot (${observation.image.unavailable.code})` : null,
    observation.other_window_focused ? "another window of the app in front" : null,
  ].filter(Boolean);
  return `window "${observation.window_title ?? "?"}", ${observation.elements?.length ?? 0} elements (${top || "none"})${gaps.length ? `; ${gaps.join("; ")}` : ""}`;
}

const label = (element) => String(element.label ?? "").trim().toLowerCase();
const find = (observation, roles, labels) => observation?.elements?.find((element) => roles.includes(element.role) && labels.includes(label(element)));
const center = (element) => ({ x: Math.round(element.x + element.w / 2), y: Math.round(element.y + element.h / 2) });
const digits = (value) => String(value ?? "").replace(/[^0-9.-]/g, "");

/** Opens a session, choosing the check's own window by title when the app has several. */
async function openApp(call, app, mode, purpose, title) {
  let opened = await call("computer_open", { app_id: app, mode, purpose });
  if (!opened.ok && opened.first.code === "window_ambiguous" && title) {
    const windows = [...String(opened.first.message).matchAll(/(\d+): ([^;]+?)(?=;|\. |$)/g)];
    const id = windows.findLast(([, , name]) => name.trim() === title)?.[1];
    if (id) opened = await call("computer_open", { app_id: app, mode, purpose, window_id: Number(id) });
  }
  return opened;
}

function expect(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { expected: true });
}

/** Calculator's labels differ by macOS version; accept the common ones. */
const KEYS = {
  clear: ["all clear", "clear", "ac", "c"],
  "7": ["7", "seven"], "5": ["5", "five"],
  add: ["add", "+", "plus"], equals: ["equals", "=", "equal"],
};
function key(observation, name) {
  const element = find(observation, ["Button"], KEYS[name]);
  expect(element, `Calculator has no "${name}" button in the observation.`);
  return element;
}

async function calculatorShows(call, expected) {
  const seen = await call("computer_observe", { include_image: false, elements: "all" });
  expect(seen.ok, `Observing the result failed: ${seen.first.code}.`);
  const shown = seen.observation.elements.filter((element) => element.value !== undefined).map((element) => digits(element.value));
  expect(shown.includes(expected), `Calculator shows ${JSON.stringify(shown)}, not ${expected}.`);
}

async function openCalculator(call) {
  const opened = await call("computer_open", { app_id: CALCULATOR, mode: "control", purpose: "Check computer use on Calculator" });
  expect(opened.ok, `Opening Calculator failed: ${opened.first.code}: ${opened.first.message}`);
  const seen = opened.observation ?? (await call("computer_observe", { include_image: true, elements: "interactive" })).observation;
  expect(seen, "No observation after opening Calculator.");
  return seen;
}

const scenarios = {
  /** What the agent can see, without taking the front: a complete accessibility read and a screenshot. */
  async "see-apps"({ call, scratch }) {
    const file = join(scratch, "computer-use-check.txt");
    await writeFile(file, "What the agent sees.");
    await run("/usr/bin/open", ["-g", "-a", "TextEdit", file]);
    await delay(1500);
    const blind = [];
    for (const app of [CALCULATOR, TEXTEDIT]) {
      const opened = await openApp(call, app, "observe", "Check what computer use can see", "computer-use-check.txt");
      expect(opened.ok, `Opening ${app} to look failed: ${opened.first.code}: ${opened.first.message}`);
      const seen = (await call("computer_observe", { include_image: true, elements: "interactive" })).observation;
      if (!seen || seen.truncated || !seen.image?.included) blind.push(`${app}: ${describe(seen)}`);
      await call("computer_close");
    }
    expect(!blind.length, `The agent cannot fully see ${blind.join(" | ")}.`);
  },

  /** Accessible presses: 7 + 5 = in one batch. */
  async "calculator-press"({ call }) {
    const seen = await openCalculator(call);
    const acted = await call("computer_act", {
      observation_id: seen.observation_id, intent: "adding 7 and 5",
      actions: ["clear", "7", "add", "5", "equals"].map((name) => ({ type: "press", ref: key(seen, name).ref })),
    });
    expect(acted.ok, `Pressing failed: ${acted.first.code}: ${acted.first.message}`);
    await calculatorShows(call, "12");
  },

  /** Pointer clicks at the buttons' centers, one fresh screenshot per click. */
  async "calculator-click"({ call }) {
    let seen = await openCalculator(call);
    for (const name of ["clear", "7", "add", "5", "equals"]) {
      if (!seen.image?.included) seen = (await call("computer_observe", { include_image: true, elements: "interactive" })).observation;
      const clicked = await call("computer_act", { observation_id: seen.observation_id, intent: `clicking ${name}`, action: { type: "click", ...center(key(seen, name)) } });
      expect(clicked.ok, `Clicking ${name} failed: ${clicked.first.code}: ${clicked.first.message}`);
      seen = clicked.observation ?? (await call("computer_observe", { include_image: true, elements: "interactive" })).observation;
      expect(seen, `No observation after clicking ${name}.`);
    }
    await calculatorShows(call, "12");
  },

  /** A sheet the agent opens is followed, and closing it returns to the window: TextEdit's Print sheet. */
  async "dialog-follow"({ call, scratch }) {
    const file = join(scratch, "computer-use-check.txt");
    await writeFile(file, "Print me.");
    await run("/usr/bin/open", ["-a", "TextEdit", file]);
    await delay(1500);
    const opened = await openApp(call, TEXTEDIT, "control", "Check dialogs in TextEdit", "computer-use-check.txt");
    expect(opened.ok, `Opening TextEdit failed: ${opened.first.code}: ${opened.first.message}`);
    const seen = opened.observation ?? (await call("computer_observe", { elements: "interactive" })).observation;
    const printed = await call("computer_act", { observation_id: seen.observation_id, intent: "opening Print", action: { type: "key", key: "p", modifiers: ["command"] } });
    expect(printed.ok, `Opening Print failed: ${printed.first.code}: ${printed.first.message}`);
    await delay(800);
    const sheet = (await call("computer_observe", { elements: "interactive" })).observation;
    expect(sheet?.dialog?.kind === "sheet", `The Print sheet was not followed. Last seen: ${describe(sheet)}.`);
    const cancel = sheet.elements?.find((element) => element.role === "Button" && /cancel/i.test(label(element)));
    expect(cancel, "The Print sheet has no Cancel button in the observation.");
    const closed = await call("computer_act", { observation_id: sheet.observation_id, intent: "closing Print", action: { type: "press", ref: cancel.ref } });
    expect(closed.ok, `Cancelling Print failed: ${closed.first.code}: ${closed.first.message}`);
    await delay(500);
    const back = (await call("computer_observe", { elements: "interactive" })).observation;
    expect(back?.dialog_closed === true && !back.dialog, `The session did not return to the window. Last seen: ${describe(back)}.`);
  },

  /** Keyboard typing and a save shortcut, checked against the file on disk. */
  async "textedit-type"({ call, scratch }) {
    const file = join(scratch, "computer-use-check.txt");
    await writeFile(file, "Start.");
    await run("/usr/bin/open", ["-a", "TextEdit", file]);
    await delay(1500);
    const opened = await openApp(call, TEXTEDIT, "control", "Check typing in TextEdit", "computer-use-check.txt");
    expect(opened.ok, `Opening TextEdit failed: ${opened.first.code}: ${opened.first.message}`);
    let seen = opened.observation ?? (await call("computer_observe", { include_image: true, elements: "interactive" })).observation;
    const area = seen?.elements?.find((element) => element.role === "TextArea");
    expect(area, "TextEdit's text area is not in the observation.");
    const marker = `Typed by the check ${Date.now()}.`;
    const typed = await call("computer_act", {
      observation_id: seen.observation_id, intent: "typing and saving",
      actions: [{ type: "click", ...center(area) }, { type: "key", key: "down", modifiers: ["command"] }, { type: "type", text: ` ${marker}` }, { type: "key", key: "s", modifiers: ["command"] }],
    });
    expect(typed.ok, `Typing failed: ${typed.first.code}: ${typed.first.message}`);
    let saved = "";
    for (let attempt = 0; attempt < 10 && !saved.includes(marker); attempt++) { await delay(300); saved = await readFile(file, "utf8"); }
    expect(saved.includes(marker), `The file on disk does not contain the typed text: ${JSON.stringify(saved)}.`);
    // Close only the check's own window, through its close button.
    seen = typed.observation ?? (await call("computer_observe", { include_image: false, elements: "interactive" })).observation;
    const close = find(seen, ["Button"], ["close button", "close"]);
    if (close) await call("computer_act", { observation_id: seen.observation_id, action: { type: "press", ref: close.ref } });
  },

  /** Another app comes to the front in the middle of a batch, as when the person switches away. */
  async "focus-switch"({ call, desktop }) {
    const seen = await openCalculator(call);
    const presses = (names) => names.map((name) => ({ type: "press", ref: key(seen, name).ref }));
    const pending = call("computer_act", { observation_id: seen.observation_id, intent: "adding 7 and 5 while another app takes the front", actions: [...presses(["clear", "7"]), { type: "wait", ms: 2000 }, ...presses(["add", "5", "equals"])] });
    await delay(700);
    await run("/usr/bin/open", desktop.version ? [desktop.version.bundle] : ["-a", "Finder"]);
    const acted = await pending;
    expect(acted.ok, `The batch stopped when another app came to the front: ${acted.first.code}: ${acted.first.message}`);
    await calculatorShows(call, "12");
  },
};

const desktop = await bridge();
if (!desktop) {
  console.error("No running OpenWork desktop found. Start a signed OpenWork build with computer use on, then rerun.");
  process.exit(2);
}
if (await screenLocked()) {
  console.error("This Mac is locked. Unlock it, then rerun.");
  process.exit(2);
}
desktop.version = await desktopVersion();
const only = option("--only")?.split(",").map((name) => name.trim()).filter(Boolean);
const selected = Object.keys(scenarios).filter((name) => !only || only.includes(name));
console.log(`OpenWork ${desktop.version?.version ?? "(version unknown)"} · ${selected.length} scenario(s) · keep your hands off the mouse and keyboard\n`);

const results = [];
// One fixed folder, so a rerun reuses the check's own TextEdit window instead of opening another.
const scratch = join(tmpdir(), "openwork-mac-apps-check");
await mkdir(scratch, { recursive: true });
try {
  for (const name of selected) {
    const session = chat(desktop, name);
    // Each scenario starts where a person asking for it would be: in OpenWork.
    if (desktop.version) { await run("/usr/bin/open", [desktop.version.bundle]); await delay(800); }
    const started = performance.now();
    let error = null;
    try { await scenarios[name]({ call: session.call, desktop, scratch }); }
    catch (caught) { error = caught; }
    finally { await session.call("computer_close").catch(() => {}); }
    if (error && await screenLocked()) {
      console.error(`The Mac locked during ${name}, so its result does not count. Unlock it and rerun.`);
      process.exit(2);
    }
    const busy = session.steps.find((step) => step.code === "computer_busy" || step.code === "computer_unavailable");
    if (busy) {
      console.error(busy.code === "computer_busy"
        ? "Another chat is using the computer. Stop it, or wait for it to finish, then rerun."
        : "Computer use is off or unavailable in this OpenWork app. Turn it on in Settings › Computer use, then rerun.");
      process.exit(2);
    }
    const steps = session.steps.filter((step) => step.tool !== "computer_close");
    const result = {
      scenario: name, passed: !error, reason: error ? `${error.message} Last seen: ${describe(session.seen.last)}.` : null,
      calls: steps.length, computerMs: steps.reduce((sum, step) => sum + step.ms, 0), wallMs: Math.round(performance.now() - started), steps,
    };
    results.push(result);
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${name}  ${result.calls} calls, ${result.computerMs} ms in the computer${result.reason ? `\n      ${result.reason}` : ""}`);
    console.log(`      ${steps.map((step) => `${step.tool.replace("computer_", "")} ${step.ms}ms${step.ok ? "" : ` (${step.code})`}`).join(" · ")}`);
    const actions = steps.filter((step) => step.desktop);
    if (actions.length) {
      const disturbed = actions.filter((step) => Object.values(step.desktop).some(Boolean)).length;
      console.log(`      ${actions[0].delivery ?? "foreground"} input · front app, cursor or Space changed in ${disturbed} of ${actions.length} actions`);
    }
    if (error && !error.expected) console.error(error);
  }
} finally {
  console.log(`\nThe check's files stay in ${scratch} so a rerun reuses its window.`);
}

const output = option("--json");
if (output) await writeFile(output, `${JSON.stringify({ desktop: desktop.version, results }, null, 2)}\n`);
const failed = results.filter((result) => !result.passed).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
