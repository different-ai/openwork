/**
 * Checks against a running workshop pair (worlds/workshop-pair.ts). Each command
 * attaches to the live desktop and browser, acts like the attendee, records a
 * receipt and screenshot under <output-dir>/checks/, and leaves the pair running.
 *
 *   node worlds/workshop-pair-check.ts <output-dir> prepare|status|task|steer|stop|unlock|reset|workshop|guide
 *
 * `workshop` runs the four attendee exercises (deck + reply, Jira + Confluence,
 * calendar move, missing policy) as fresh tasks, verifies each from the attendee's
 * own workplace state, then resets and proves OAuth still reads.
 *
 * `guide` runs each hands-on presenter-guide prompt verbatim in a fresh task,
 * judges it PASS/PARTIAL/FAIL against the guide's "Expect this:" line from the
 * attendee's own state, keeps going after failures, then resets.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachSurface, browserScript, probeAppStateOnSurface } from "../evals/packages/cdp/src/index.ts";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { control, evalIn, waitFor } from "../evals/packages/behaviors/src/desktop.ts";
import { readComposerState, sendComposerMessage, waitForAssistantReply, writeComposerText } from "../evals/packages/behaviors/src/composer.ts";
import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../evals/packages/behaviors/src/den.ts";
import { defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { parsePrivatePreview } from "../evals/packages/hosts/src/private-web-preview.ts";
import { foregroundWorkshopDesktop, WORKPLACE_ORIGIN } from "./lib/workshop-browser.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { typeThroughWorkshopViewer } from "./lib/workshop-viewer.ts";
import { freshComposer, verifyMember, verifyViewer } from "./workshop-fleet.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, field: string): string {
  assert.ok(record(value) && typeof value[field] === "string" && value[field], `control.json is missing ${field}; did the pair reach that stage?`);
  return String(value[field]);
}
const STOP = /^(stop|stop task|stop generating)$/i;

async function attach(id: string, port: number, kind: "chrome" | "electron") {
  let result = await defaultDaytonaExec(["preview-url", id, "-p", String(port), "--expires", "3600"], { timeoutMs: 30_000 });
  for (let retry = 0; result.code !== 0 && retry < 3; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    result = await defaultDaytonaExec(["preview-url", id, "-p", String(port), "--expires", "3600"], { timeoutMs: 30_000 });
  }
  assert.equal(result.code, 0, "Private control endpoint could not be minted");
  const cdpUrl = parsePrivatePreview(result.stdout, id, port).browserOrigin;
  return attachSurface({ name: `workshop-pair-${kind}`, hostKind: "daytona", sandboxId: id, kind, cdpUrl });
}
async function capture(surface: Surface, path: string) {
  const image: unknown = await surface.client.send("Page.captureScreenshot", { format: "png" });
  if (record(image) && typeof image.data === "string") await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
}
async function busy(desktop: Surface): Promise<boolean> {
  const value = await evalIn(desktop, browserScript((pattern) => [...document.querySelectorAll("button")]
    .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()) && !button.disabled), [STOP.source]));
  return value === true;
}
async function waitIdle(desktop: Surface, timeoutMs: number, label: string) {
  await waitFor(desktop, browserScript((pattern) => ![...document.querySelectorAll("button")]
    .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()))
    && !document.querySelector('[data-status="pending"], [data-status="running"]'), [STOP.source]), { timeoutMs, label });
}
/** Trusted keyboard Ctrl+Enter, exactly what the attendee presses to steer. */
async function pressCtrlEnter(desktop: Surface) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 };
  await desktop.client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await desktop.client.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
  await desktop.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function userMessages(desktop: Surface): Promise<number> {
  const value = await evalIn(desktop, () => document.querySelectorAll('[data-message-role="user"]').length);
  return typeof value === "number" ? value : 0;
}

// ---- Whole-workshop helpers: every fact comes from the attendee's own workplace page. ----
type Row = Record<string, unknown>;
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter(record) : []; }
function canonical(value: unknown): string { return JSON.stringify(value) ?? ""; }
function businessState(value: Row): Row { const { audit: _audit, ...business } = value; return business; }
function nested(value: Row, field: string, list: string): Row[] { const inner = value[field]; return record(inner) ? rows(inner[list]) : []; }
async function workplaceState(browser: Surface): Promise<{ microsoft: Row; atlassian: Row }> {
  await evalIn(browser, browserScript((origin) => { if (location.origin !== origin) location.href = `${origin}/`; return true; }, [WORKPLACE_ORIGIN]));
  await waitFor(browser, browserScript((origin) => location.origin === origin && document.readyState === "complete", [WORKPLACE_ORIGIN]), { timeoutMs: 60_000, label: "attendee workplace page" });
  const value = await evalIn(browser, async () => {
    const read = async (service: string) => {
      const response = await fetch(`/_workshop/state/${service}`);
      if (!response.ok) throw new Error(`Own workplace state HTTP ${response.status}`);
      return response.json();
    };
    return { microsoft: await read("microsoft"), atlassian: await read("atlassian") };
  }, { timeoutMs: 45_000 });
  assert.ok(record(value) && record(value.microsoft) && record(value.atlassian), "Attendee workplace state unavailable");
  return { microsoft: value.microsoft, atlassian: value.atlassian };
}
function auditCursor(state: Row): number { return Math.max(0, ...rows(state.audit).map((entry) => Number(entry.sequence) || 0)); }
function auditSince(state: Row, cursor: number): Row[] { return rows(state.audit).filter((entry) => (Number(entry.sequence) || 0) > cursor); }
const MUTATING = /create|update|delete|send|write|patch|remove|add|upload|draft|move|copy|archive|restore|forward|reply|assign|transition|comment|mark/i;
const ZONE_ALIASES: Record<string, string> = { "Pacific Standard Time": "America/Los_Angeles", "Eastern Standard Time": "America/New_York", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris" };
function zoneOffset(zone: string, at: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(at / 1000) * 1000;
}
/** Graph-style { dateTime, timeZone } (or an offset/Z string) to an absolute instant. */
function instant(value: unknown): number {
  assert.ok(record(value) && typeof value.dateTime === "string", "Event time lacks dateTime");
  const dateTime = value.dateTime.replace(/(\.\d{3})\d+/, "$1");
  if (/(Z|[+-]\d\d:?\d\d)$/.test(dateTime)) return Date.parse(dateTime);
  const zoneName = typeof value.timeZone === "string" ? value.timeZone : "UTC";
  const zone = ZONE_ALIASES[zoneName] ?? zoneName;
  const wall = Date.parse(`${dateTime}Z`);
  assert.ok(Number.isFinite(wall), `Unparseable event dateTime ${dateTime}`);
  if (/^(UTC|Etc\/UTC|GMT)$/i.test(zone)) return wall;
  const first = wall - zoneOffset(zone, wall);
  return wall - zoneOffset(zone, first);
}
/** Waits for the task to finish, answering question cards with the (Recommended) option and permission cards with "Allow once", as an attendee would. */
async function settleTask(desktop: Surface, name: string, begin: number, timeoutMs: number, approvePermissions = false): Promise<{ questions: Row[]; permissions: Row[] }> {
  const questions: Row[] = [], permissions: Row[] = [];
  const deadline = begin + timeoutMs;
  for (;;) {
    const seen = await evalIn(desktop, browserScript((pattern) => {
      const idle = ![...document.querySelectorAll("button")]
        .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()))
        && !document.querySelector('[data-status="pending"], [data-status="running"]')
        && !/^Working(?:\.{3}|…)?$/m.test(document.body.innerText);
      const allow = [...document.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Allow once" && !button.disabled);
      if (allow) {
        allow.scrollIntoView({ block: "center" });
        const box = allow.getBoundingClientRect();
        const card = allow.closest("[class*=rounded]")?.parentElement ?? allow.parentElement;
        return { idle: false, question: null, permission: { text: (card?.textContent ?? "").replace(/\s+/g, " ").slice(0, 600), x: box.x + box.width / 2, y: box.y + box.height / 2 } };
      }
      const counter = [...document.querySelectorAll("div")].find((element) => /^Question \d+ of \d+$/.test((element.textContent ?? "").trim()) && element.children.length === 0);
      const panel = counter?.closest(".overflow-hidden");
      if (!panel) return { idle, question: null };
      const options = [...panel.querySelectorAll("button")].filter((button) => button.querySelector("span span"));
      const recommended = options.find((button) => /\(Recommended\)\s*$/i.test(button.querySelector("span span")?.textContent ?? ""));
      recommended?.scrollIntoView({ block: "center" });
      const box = recommended?.getBoundingClientRect();
      return {
        idle: false,
        question: (panel.textContent ?? "").replace(/\s+/g, " ").slice(0, 600),
        options: options.map((button) => (button.querySelector("span span")?.textContent ?? "").trim()),
        recommended: recommended && box && !recommended.disabled ? { label: (recommended.querySelector("span span")?.textContent ?? "").trim(), x: box.x + box.width / 2, y: box.y + box.height / 2 } : null,
      };
    }, [STOP.source]));
    assert.ok(record(seen), "Could not read task progress");
    if (seen.idle === true) break;
    const click = async (x: number, y: number) => {
      for (const type of ["mousePressed", "mouseReleased"]) await desktop.client.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    };
    if (record(seen.permission)) {
      if (!approvePermissions) throw new Error(`Agent asked for permission: ${String(seen.permission.text)}`);
      assert.ok(permissions.length < 6, "Agent kept asking for permission");
      permissions.push({ prompt: seen.permission.text, answered: "Allow once" });
      await click(Number(seen.permission.x), Number(seen.permission.y));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (typeof seen.question === "string") {
      const pick = record(seen.recommended) ? seen.recommended : null;
      if (!pick) throw new Error(`Agent asked a question with no recommended option: ${seen.question}`);
      assert.ok(questions.length < 3, "Agent kept asking questions");
      questions.push({ question: seen.question, options: seen.options, answered: pick.label });
      await click(Number(pick.x), Number(pick.y));
      await waitFor(desktop, browserScript((question) => {
        const counter = [...document.querySelectorAll("div")].find((element) => /^Question \d+ of \d+$/.test((element.textContent ?? "").trim()) && element.children.length === 0);
        const panel = counter?.closest(".overflow-hidden");
        return !panel || (panel.textContent ?? "").replace(/\s+/g, " ").slice(0, 600) !== question;
      }, [seen.question]), { timeoutMs: 30_000, label: "question answered" });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${name} finished`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { questions, permissions };
}
async function download(browser: Surface, id: string): Promise<Buffer> {
  const bytes = await evalIn(browser, browserScript(async (id) => {
    const response = await fetch(`/download/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
    const buffer = new Uint8Array(await response.arrayBuffer()); let binary = "";
    for (const byte of buffer) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, [id]), { timeoutMs: 60_000 });
  assert.ok(typeof bytes === "string", "Download returned nothing");
  return Buffer.from(bytes, "base64");
}
function inspectPptx(path: string): { zip: boolean; slides: { name: string; text: string }[] } {
  const value: unknown = JSON.parse(execFileSync("python3", ["-c", `import json,re,sys,zipfile,xml.etree.ElementTree as E
out={'zip':zipfile.is_zipfile(sys.argv[1]),'slides':[]}
if out['zip']:
 with zipfile.ZipFile(sys.argv[1]) as z:
  names=[n for n in z.namelist() if re.match(r'^ppt/slides/slide\\d+\\.xml$',n)]
  names.sort(key=lambda n:int(re.findall(r'\\d+',n)[-1]))
  out['slides']=[{'name':n,'text':' '.join(t.text or '' for t in E.fromstring(z.read(n)).iter() if t.tag.endswith('}t'))} for n in names]
print(json.dumps(out))`, path], { encoding: "utf8" }));
  assert.ok(record(value));
  return { zip: value.zip === true, slides: rows(value.slides).map((slide) => ({ name: String(slide.name), text: String(slide.text) })) };
}
/** The ```text prompt under the guide heading that ends with "(Txx)", byte for byte. */
function guidePrompt(guide: string, id: string): string {
  const lines = guide.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("## ") && line.trimEnd().endsWith(`(${id})`));
  assert.ok(heading >= 0, `Presenter guide has no ${id} section`);
  const open = lines.findIndex((line, index) => index > heading && line.trim() === "```text");
  const close = lines.findIndex((line, index) => index > open && line.trim() === "```");
  assert.ok(open > heading && close > open, `Presenter guide ${id} has no text prompt`);
  return lines.slice(open + 1, close).join("\n").trim();
}
function strip(html: string): string { return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim(); }
function attendeeSet(event: Row): string[] {
  return rows(event.attendees).map((attendee) => {
    const address = record(attendee.emailAddress) ? String(attendee.emailAddress.address ?? "").toLowerCase() : "";
    return `${address}|${String(attendee.type ?? "required")}`;
  }).sort();
}

export async function main(argv = process.argv.slice(2)) {
  const [outputDir, command] = argv;
  assert.ok(outputDir && command && ["prepare", "status", "task", "steer", "stop", "unlock", "reset", "workshop", "guide"].includes(command),
    "Usage: node worlds/workshop-pair-check.ts <output-dir> prepare|status|task|steer|stop|unlock|reset|workshop|guide");
  const pair: unknown = JSON.parse(await readFile(join(outputDir, "control.json"), "utf8"));
  const desktopId = text(pair, "desktopSandbox");
  const orgId = text(pair, "orgId"), memberId = text(pair, "memberId"), modelId = text(pair, "modelId");
  assert.ok(record(pair) && record(pair.memberLogin));
  const login = pair.memberLogin;
  const member: DenSession = { email: text(login, "email"), password: text(login, "password"), token: text(login, "token"), apiUrl: text(login, "apiUrl"), webUrl: text(login, "webUrl") };
  const checks = join(outputDir, "checks");
  await mkdir(checks, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  await using desktop = await attach(desktopId, 9825, "electron");
  await using browser = await attach(desktopId, 9222, "chrome");
  const receipt: Record<string, unknown> = { command, startedAt: new Date(startedAt).toISOString() };
  const finish = async (passed: boolean, extra: Record<string, unknown> = {}) => {
    Object.assign(receipt, extra, { passed, seconds: Math.round((Date.now() - startedAt) / 1000) });
    await capture(desktop, join(checks, `${command}.png`)).catch(() => {});
    await writeFile(join(checks, `${command}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(`${passed ? "PASS" : "FAIL"} ${command} (${receipt.seconds}s) — receipt ${join(checks, `${command}.json`)}`);
  };
  try {
    if (command === "prepare") {
      // Finish a pair whose last setup stages failed: fresh task on the workshop
      // model, then a private interactive viewer link recorded in control.json.
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop, modelId);
      const expires = Math.max(60, Math.min(86400, Math.floor((Date.parse(text(pair, "expiresAt")) - Date.now()) / 1000)));
      const signed = await defaultDaytonaExec(["preview-url", desktopId, "-p", "6080", "--expires", String(expires)], { timeoutMs: 30_000 });
      assert.equal(signed.code, 0, "Could not mint the private viewer link.");
      const origin = parsePrivatePreview(signed.stdout, desktopId, 6080).browserOrigin;
      const viewer = `${origin}/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&reconnect_delay=2000`;
      await verifyViewer(viewer, desktopId);
      Object.assign(pair, { viewer, preparedAt: new Date().toISOString() });
      await writeFile(join(outputDir, "control.json"), `${JSON.stringify(pair, null, 2)}\n`, { mode: 0o600 });
      return await finish(true, { viewerVerified: true, freshComposerOnWorkshopModel: true });
    }
    if (command === "status") {
      const auth = await control(desktop, "auth.status");
      const app = await probeAppStateOnSurface(desktop);
      const models = await control(desktop, "models.list", { workspaceId: app.workspaceId });
      const listed = record(models) && Array.isArray(models.models) ? models.models.filter(record) : [];
      const usable = await denFetch(member, "/v1/mcp-connections?scope=usable", { headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId } });
      const connections = record(usable.body) && Array.isArray(usable.body.connections) ? usable.body.connections.filter(record) : [];
      const budget = await verifyMember(member, orgId, memberId);
      const facts = {
        signedInAs: record(auth) && record(auth.user) ? auth.user.email : null,
        workshopModelAvailable: listed.some((model) => model.modelId === modelId && model.available === true),
        connectedForMe: connections.map((connection) => ({ name: connection.name, connected: connection.connectedForMe === true })),
        budget: { usedMicroUsd: budget.usedMicroUsd, allowanceMicroUsd: budget.allowanceMicroUsd },
        busy: await busy(desktop),
      };
      const passed = facts.signedInAs === member.email && facts.workshopModelAvailable && facts.connectedForMe.length === 5 && facts.connectedForMe.every((entry) => entry.connected);
      return await finish(passed, { facts });
    }
    if (command === "unlock") {
      await unlockWorkshopDesktop(desktopId);
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop);
      const marker = `unlock-${Date.now().toString(36)}`;
      await typeThroughWorkshopViewer(text(pair, "viewer"), marker);
      await waitFor(desktop, browserScript((marker) => (document.querySelector<HTMLElement>('[contenteditable="true"]')?.innerText ?? "").includes(marker), [marker]),
        { timeoutMs: 30_000, label: "keyboard input through the private viewer reached the composer" });
      await capture(desktop, join(checks, "unlock-typed.png"));
      await control(desktop, "composer.set_text", { text: "" });
      return await finish(true, { viewerKeyboardReachedComposer: true });
    }
    if (command === "reset") {
      await evalIn(browser, browserScript((origin) => { if (location.origin !== origin) location.href = `${origin}/`; return true; }, [WORKPLACE_ORIGIN]));
      await waitFor(browser, browserScript((origin) => location.origin === origin && document.readyState === "complete", [WORKPLACE_ORIGIN]), { timeoutMs: 60_000, label: "workplace page" });
      // The attendee's own page and cookie: the same POST the "Reset my sample data" button sends.
      const result = await evalIn(browser, async () => {
        const drafts = async () => ((await (await fetch("/_workshop/state/microsoft")).json()).messages ?? []).filter((message: { isDraft?: boolean }) => message.isDraft).length;
        const before = await drafts();
        const response = await fetch("/_workshop/reset", { method: "POST", redirect: "manual" });
        return { status: response.status, type: response.type, draftsBefore: before, draftsAfter: await drafts() };
      });
      const passed = record(result) && (result.status === 303 || result.type === "opaqueredirect");
      await foregroundWorkshopDesktop(browser, desktop);
      return await finish(passed, { result });
    }

    if (command === "workshop") {
      // The whole workshop as the attendee: each exercise is a fresh task typed
      // into the real composer, then judged only from this attendee's own state.
      const marker = `WS${Date.now().toString(36).toUpperCase()}`;
      const budgetCapMicroUsd = 3_000_000;
      const tasks: Row[] = [];
      Object.assign(receipt, { marker, tasks });
      const save = async () => writeFile(join(checks, "workshop.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      const spendStart = Number((await verifyMember(member, orgId, memberId)).usedMicroUsd ?? 0);
      const baseline = await workplaceState(browser);
      receipt.baselineUsedMicroUsd = spendStart;
      const run = async (name: string, prompt: string, timeoutMs = 600_000) => {
        await foregroundWorkshopDesktop(browser, desktop);
        await freshComposer(desktop, modelId);
        const before = await workplaceState(browser);
        const usedBefore = Number((await verifyMember(member, orgId, memberId)).usedMicroUsd ?? 0);
        const begin = Date.now();
        await sendComposerMessage(desktop, prompt);
        await waitForAssistantReply(desktop, { timeoutMs });
        // Question cards are answered like the attendee would: the (Recommended) option.
        const { questions } = await settleTask(desktop, name, begin, timeoutMs);
        const reply = (await waitForAssistantReply(desktop, { timeoutMs: 5_000 })).text;
        const seconds = Math.round((Date.now() - begin) / 1000);
        await capture(desktop, join(checks, `workshop-${name}.png`));
        const after = await workplaceState(browser);
        const usedAfter = Number((await verifyMember(member, orgId, memberId)).usedMicroUsd ?? 0);
        const tools = [...auditSince(after.microsoft, auditCursor(before.microsoft)), ...auditSince(after.atlassian, auditCursor(before.atlassian))]
          .map((entry) => `${String(entry.name)}:${String(entry.status)}`);
        const entry: Row = { name, prompt, seconds, reply, questions, workplaceCalls: tools, costMicroUsd: usedAfter - usedBefore, passed: false };
        tasks.push(entry); await save();
        assert.ok(usedAfter - spendStart <= budgetCapMicroUsd, `Workshop spend ${usedAfter - spendStart} micro-USD exceeded the $3 cap`);
        return { entry, reply, before, after };
      };
      const verified = async (entry: Row, facts: Row) => { Object.assign(entry, { facts, passed: true }); await save(); console.log(`PASS workshop ${String(entry.name)} (${String(entry.seconds)}s)`); };
      const sent = (state: Row) => rows(state.messages).filter((message) => message.parentFolderId === "sentitems").length;

      // 1. One-slide PPTX in Drive plus an unsent reply in the existing thread.
      {
        const fileName = `${marker}-readiness.pptx`;
        const { entry, before, after } = await run("1-pptx-reply", `Read the Northwind pilot email thread and the shared pilot brief. Make a one-slide PowerPoint explaining what is verified and what still needs acceptance, save it to my Drive named ${fileName}, and draft a reply in the existing Northwind thread with the link. Don't send it. You may use shell with the Python standard library (zipfile) to build the .pptx; no package installs.`);
        const files = rows(after.microsoft.files).filter((file) => file.name === fileName);
        assert.equal(files.length, 1, `Expected exactly one Drive file named ${fileName}, found ${files.length}`);
        const file = files[0]; assert.ok(file && typeof file.id === "string");
        const bytes = await evalIn(browser, browserScript(async (id) => {
          const response = await fetch(`/download/${encodeURIComponent(id)}`);
          if (!response.ok) throw new Error(`PPTX download HTTP ${response.status}`);
          const buffer = new Uint8Array(await response.arrayBuffer()); let binary = "";
          for (const byte of buffer) binary += String.fromCharCode(byte);
          return btoa(binary);
        }, [file.id]), { timeoutMs: 60_000 });
        assert.ok(typeof bytes === "string" && bytes.length > 0, "Downloaded PPTX was empty");
        const pptxPath = join(checks, "workshop-readiness-downloaded.pptx");
        await writeFile(pptxPath, Buffer.from(bytes, "base64"), { mode: 0o600 });
        const inspected: unknown = JSON.parse(execFileSync("python3", ["-c", `import json,sys,zipfile,xml.etree.ElementTree as E
ok=zipfile.is_zipfile(sys.argv[1])
out={'zip':ok}
if ok:
 with zipfile.ZipFile(sys.argv[1]) as z:
  names=z.namelist()
  slides=[n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml') and '/_rels/' not in n]
  out.update({'slides':slides,'presentationXml':'ppt/presentation.xml' in names,'contentTypes':'[Content_Types].xml' in names,
   'text':' '.join(n.text or '' for s in slides for n in E.fromstring(z.read(s)).iter() if n.tag.endswith('}t'))})
print(json.dumps(out))`, pptxPath], { encoding: "utf8" }));
        assert.ok(record(inspected) && inspected.zip === true, "Saved deck is not a ZIP (not a real .pptx)");
        assert.ok(Array.isArray(inspected.slides) && inspected.slides.length === 1, `Expected exactly one ppt/slides/slideN.xml, found ${canonical(inspected.slides)}`);
        assert.ok(inspected.presentationXml === true && inspected.contentTypes === true, "PPTX lacks presentation.xml or [Content_Types].xml");
        const slideText = String(inspected.text);
        assert.match(slideText, /497\s*(?:\/|of)\s*500|99\.4/i, "Slide lacks the verified lab result (497/500 or 99.4%)");
        assert.match(slideText, /aisle\s*C/i, "Slide lacks aisle C");
        assert.match(slideText, /roam/i, "Slide lacks the roaming test");
        assert.match(slideText, /pending|still needs|needs acceptance|awaiting|not yet|outstanding/i, "Slide lacks pending/acceptance wording");
        const oldIds = new Set(rows(before.microsoft.messages).map((message) => message.id));
        const newDrafts = rows(after.microsoft.messages).filter((message) => message.isDraft === true && !oldIds.has(message.id));
        assert.equal(newDrafts.length, 1, `Expected exactly one new draft, found ${newDrafts.length}`);
        const draft = newDrafts[0]; assert.ok(draft);
        assert.equal(draft.conversationId, "thread-northwind", "New draft is not in the existing Northwind thread");
        const link = new RegExp(`(?:drive\\?item=|/download/)${String(file.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
        assert.match(canonical(draft.body), link, "Draft body does not link the saved deck");
        assert.equal(sent(after.microsoft), sent(before.microsoft), "Sent items changed; something was sent");
        assert.deepEqual(businessState(after.atlassian), businessState(before.atlassian), "PPTX task changed Jira/Confluence");
        await verified(entry, { fileId: file.id, fileName, slides: inspected.slides, slideText: slideText.slice(0, 1200), draftId: draft.id, draftConversation: draft.conversationId, sentUnchanged: sent(after.microsoft) });
      }

      // 2. Engineering task plus a preserving append to the Northwind account page.
      {
        const { entry, before, after } = await run("2-jira-confluence", `Create an engineering task for the aisle C Wi-Fi roaming test before the pilot readiness decision, include ${marker}. Add a labeled follow-up section to the existing Northwind account page linking the task, preserving existing content.`);
        const oldKeys = new Set(nested(before.atlassian, "jira", "issues").map((issue) => issue.key));
        const newIssues = nested(after.atlassian, "jira", "issues").filter((issue) => !oldKeys.has(issue.key));
        assert.equal(newIssues.length, 1, `Expected exactly one new Jira issue, found ${newIssues.length}: ${canonical(newIssues.map((issue) => [issue.key, issue.issuetype]))}`);
        const issue = newIssues[0]; assert.ok(issue);
        assert.equal(issue.issuetype, "Task", `New issue is ${String(issue.issuetype)}, not Task`);
        assert.notEqual(issue.project, "ITSD", "New issue is an IT service request");
        assert.ok(canonical(issue).includes(marker), "New issue lacks the marker");
        const beforePages = nested(before.atlassian, "confluence", "pages"), afterPages = nested(after.atlassian, "confluence", "pages");
        const original = beforePages.find((page) => page.title === "Account plan: Northwind Logistics"); assert.ok(original, "Baseline Northwind account page missing");
        const page = afterPages.find((entry) => entry.id === original.id); assert.ok(page, "Northwind account page disappeared");
        assert.equal(afterPages.length, beforePages.length, "A new (replacement) Confluence page was created");
        assert.equal(page.title, original.title);
        assert.ok(String(page.body).includes(String(original.body)), "Northwind page no longer contains its original body");
        assert.ok(String(page.body).includes(marker), "Northwind page lacks the marker");
        assert.ok(String(page.body).includes(String(issue.key)), "Northwind page does not reference the new issue key");
        assert.deepEqual(afterPages.filter((entry) => entry.id !== original.id), beforePages.filter((entry) => entry.id !== original.id), "Other Confluence pages changed");
        assert.deepEqual(businessState(after.microsoft), businessState(before.microsoft), "Jira/Confluence task changed Microsoft state");
        await verified(entry, { issueKey: issue.key, issueType: issue.issuetype, project: issue.project, pageId: page.id, pageVersion: [original.version, page.version], appendedChars: String(page.body).length - String(original.body).length });
      }

      // 3. Reschedule the existing review to tomorrow 14:00 Los Angeles.
      {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const noon = new Date(`${today}T12:00:00Z`); noon.setUTCDate(noon.getUTCDate() + 1);
        const date = noon.toISOString().slice(0, 10);
        const expected = instant({ dateTime: `${date}T14:00:00`, timeZone: "America/Los_Angeles" });
        const { entry, before, after } = await run("3-calendar", "Move the existing Northwind / Blue Harbor customer review to tomorrow at 2pm Los Angeles time, keeping its attendees and duration.");
        const original = rows(before.microsoft.events).find((event) => event.subject === "Northwind / Blue Harbor customer pilot review"); assert.ok(original, "Baseline review event missing");
        const updated = rows(after.microsoft.events).find((event) => event.id === original.id); assert.ok(updated, "Original event id no longer exists");
        assert.equal(rows(after.microsoft.events).length, rows(before.microsoft.events).length, "Event count changed (duplicate or deletion)");
        const facts = { eventId: updated.id, losAngelesToday: today, expectedStartUtc: new Date(expected).toISOString(), start: updated.start, end: updated.end };
        Object.assign(entry, { facts }); await save();
        assert.equal(instant(updated.start), expected, `Start is ${new Date(instant(updated.start)).toISOString()}, expected ${new Date(expected).toISOString()}`);
        assert.equal(instant(updated.end) - instant(updated.start), instant(original.end) - instant(original.start), "Duration changed");
        assert.deepEqual(attendeeSet(updated), attendeeSet(original), "Attendees changed");
        assert.deepEqual(rows(after.microsoft.events).filter((event) => event.id !== original.id), rows(before.microsoft.events).filter((event) => event.id !== original.id), "Other events changed");
        assert.deepEqual(businessState(after.atlassian), businessState(before.atlassian), "Calendar task changed Jira/Confluence");
        assert.equal(sent(after.microsoft), sent(before.microsoft), "Calendar task sent mail");
        await verified(entry, { ...facts, attendees: attendeeSet(updated) });
      }

      // 4. Missing dog policy: must not invent one, must not change anything.
      {
        const { entry, reply, before, after } = await run("4-policy", "Does our internal office guidance allow dogs? If you can't find a policy, say so rather than inventing one.", 300_000);
        assert.match(reply, /dog|pet/i, "Reply does not address dogs");
        assert.match(reply, /couldn.t find|could not find|didn.t find|did not find|no (?:explicit |specific |published |written |formal )?(?:dog|pet)[- ]?(?:policy|rule|guidance)?|not (?:specified|covered|stated|found|mentioned|addressed)|does(?:n.t| not) (?:mention|address|specify|say|cover)|does not contain|no policy|silent/i, "Reply does not say no policy was found");
        assert.doesNotMatch(reply, /(?<!whether |if |that )dogs? (?:are|is) (?:allowed|permitted|welcome|prohibited|banned|not allowed|not permitted)|(?<!whether |if )you (?:can|may|cannot|can.t) bring (?:your |a )?dog/i, "Reply invents a dog rule");
        assert.deepEqual(businessState(after.microsoft), businessState(before.microsoft), "Policy question changed Microsoft state");
        assert.deepEqual(businessState(after.atlassian), businessState(before.atlassian), "Policy question changed Jira/Confluence");
        await verified(entry, { stateUnchanged: true });
      }

      // Personal reset restores the pre-workshop business state; OAuth survives.
      {
        const begin = Date.now();
        const result = await evalIn(browser, async () => {
          const response = await fetch("/_workshop/reset", { method: "POST", redirect: "manual" });
          return { status: response.status, type: response.type };
        });
        assert.ok(record(result) && (result.status === 303 || result.type === "opaqueredirect"), `Personal reset failed: ${canonical(result)}`);
        const reset = await workplaceState(browser);
        const facts: Row = {
          markerGone: !canonical(businessState(reset.microsoft)).includes(marker) && !canonical(businessState(reset.atlassian)).includes(marker),
          microsoftEqualsBaseline: canonical(businessState(reset.microsoft)) === canonical(businessState(baseline.microsoft)),
          atlassianEqualsBaseline: canonical(businessState(reset.atlassian)) === canonical(businessState(baseline.atlassian)),
        };
        const resetEntry: Row = { name: "5-reset", seconds: Math.round((Date.now() - begin) / 1000), facts, passed: false };
        tasks.push(resetEntry); await save();
        await capture(browser, join(checks, "workshop-5-reset.png")).catch(() => {});
        assert.ok(facts.markerGone, "Workshop artifacts still present after reset");
        assert.deepEqual(businessState(reset.microsoft), businessState(baseline.microsoft), "Microsoft state after reset differs from pre-workshop baseline");
        assert.deepEqual(businessState(reset.atlassian), businessState(baseline.atlassian), "Atlassian state after reset differs from pre-workshop baseline");
        await verified(resetEntry, facts);
      }
      {
        const { entry, reply, before, after } = await run("6-read-after-reset", "Find the Northwind pilot readiness email and quote its exact subject in one sentence. Read only; do not change anything.", 300_000);
        const calls = [...auditSince(after.microsoft, auditCursor(before.microsoft)), ...auditSince(after.atlassian, auditCursor(before.atlassian))];
        assert.ok(!calls.some((call) => MUTATING.test(String(call.name))), `Read-only task made a mutating call: ${canonical(calls.map((call) => call.name))}`);
        assert.ok(calls.some((call) => call.status === "completed" && /^mail_/.test(String(call.name)) && /northwind/i.test(canonical(call.output))), "No completed Outlook read of Northwind in the attendee's own audit after reset");
        assert.match(reply.replace(/\s+/g, " "), /Northwind \| Atlas2 warehouse pilot readiness/i, "Reply does not quote the real subject");
        assert.deepEqual(businessState(after.microsoft), businessState(baseline.microsoft), "Read-only task changed Microsoft state");
        assert.deepEqual(businessState(after.atlassian), businessState(baseline.atlassian), "Read-only task changed Atlassian state");
        await verified(entry, { oauthIntact: true });
      }
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop, modelId);
      const spendEnd = Number((await verifyMember(member, orgId, memberId)).usedMicroUsd ?? 0);
      return await finish(true, { totalCostMicroUsd: spendEnd - spendStart, usedMicroUsdAfter: spendEnd });
    }

    if (command === "guide") {
      // Every hands-on presenter-guide prompt, verbatim, as the attendee in a
      // fresh task; each judged against its "Expect this:" line from the
      // attendee's own workplace state. A failure never stops the run.
      const guidePath = process.env.WORKSHOP_GUIDE ?? join(outputDir, "..", "..", "presenter-guide.md");
      const guide = await readFile(guidePath, "utf8");
      const capMicroUsd = 2_500_000, reserveMicroUsd = 350_000, taskTimeoutMs = 480_000;
      const tasks: Row[] = [];
      const notApplicable = [
        { id: "T07", verdict: "EXCLUDED", reason: "Windows lockout beat is excluded from hands-on." },
        { id: "T03", verdict: "NOT-APPLICABLE", reason: "Needs Nora as a second real Den member running the shared Workflow under her own identity." },
        { id: "T08", verdict: "NOT-APPLICABLE", reason: "Feedback form went to a rehearsal stand-in store; no attendee-safe equivalent." },
      ];
      Object.assign(receipt, { guidePath, tasks, notApplicable });
      const save = async () => writeFile(join(checks, "guide.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      const used = async () => Number((await verifyMember(member, orgId, memberId)).usedMicroUsd ?? 0);
      const spendStart = await used();
      const baseline = await workplaceState(browser);
      receipt.baselineUsedMicroUsd = spendStart;
      const denHeaders = { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId };
      const denList = async (path: string): Promise<{ status: number; items: Row[] }> => {
        const result = await denFetch(member, path, { headers: denHeaders }).catch(() => null);
        if (!result) return { status: 0, items: [] };
        const body = result.body;
        const list = record(body) ? Object.values(body).find(Array.isArray) : Array.isArray(body) ? body : [];
        return { status: result.response.status, items: rows(list) };
      };
      type Ctx = { begin: number; reply: string; before: { microsoft: Row; atlassian: Row }; after: { microsoft: Row; atlassian: Row }; workflowsBefore: Row[] };
      type Verdict = { verdict: "PASS" | "PARTIAL" | "FAIL"; reason: string; criteria: Row; facts: Row };
      const judge = (criteria: Record<string, boolean>, facts: Row, critical: string[]): Verdict => {
        const missing = Object.entries(criteria).filter(([, ok]) => !ok).map(([label]) => label);
        const verdict = missing.length === 0 ? "PASS" : critical.some((label) => missing.includes(label)) || missing.length === Object.keys(criteria).length ? "FAIL" : "PARTIAL";
        return { verdict, reason: missing.length ? `missing: ${missing.join("; ")}` : `all ${Object.keys(criteria).length} checks met`, criteria, facts };
      };
      const changedFiles = (ctx: Ctx) => {
        const old = new Map(rows(ctx.before.microsoft.files).map((file) => [file.id, canonical({ ...file, audit: undefined })]));
        return rows(ctx.after.microsoft.files).filter((file) => !file.folder && old.get(file.id) !== canonical({ ...file, audit: undefined }));
      };
      const newDrafts = (ctx: Ctx) => {
        const old = new Set(rows(ctx.before.microsoft.messages).map((message) => message.id));
        return rows(ctx.after.microsoft.messages).filter((message) => message.isDraft === true && !old.has(message.id));
      };
      const sentCount = (state: Row) => rows(state.messages).filter((message) => message.parentFolderId === "sentitems").length;
      const nothingSent = (ctx: Ctx) => sentCount(ctx.after.microsoft) === sentCount(ctx.before.microsoft);
      const same = (a: Row, b: Row) => canonical(businessState(a)) === canonical(businessState(b));
      const bodyOf = (message: Row) => record(message.body) ? String(message.body.content ?? "") : String(message.body ?? "");
      const textFile = async (file: Row) => (await download(browser, String(file.id))).toString("utf8");
      const links = (body: string, file: Row) => body.includes(String(file.id)) || body.includes(String(file.name)) || body.includes(encodeURIComponent(String(file.name)));
      const pages = (state: Row) => nested(state, "confluence", "pages");
      const version = (page: Row) => record(page.version) ? Number(page.version.number) : Number(page.version);
      const KG1200 = /1[,.\u202f\u00a0 ]?200\s*kg/i, KG300 = /\b300\s*kg/i;

      const checksById: Record<string, (ctx: Ctx) => Promise<Verdict>> = {
        T01: async (ctx) => {
          const files = changedFiles(ctx).filter((file) => /\.(md|txt|html?|docx)$/i.test(String(file.name)));
          const file = files.find((entry) => /compar|atlas|blue/i.test(String(entry.name))) ?? files[0];
          const content = file && /\.(md|txt|html?)$/i.test(String(file.name)) ? await textFile(file) : "";
          const drafts = newDrafts(ctx).filter((draft) => draft.conversationId === "thread-blueharbor");
          const draft = drafts[0]; const body = draft ? bodyOf(draft) : "";
          return judge({
            "comparison file saved in Drive": Boolean(file),
            "file has Atlas 2 300 kg and Atlas Lift 1,200 kg": KG300.test(content) && KG1200.test(content),
            "file keeps customer safety/site requirements open": /unconfirmed|not (?:yet )?confirmed|to be confirmed|open|pending|outstanding|not verified/i.test(content),
            "unsent reply draft in the Blue Harbor thread": drafts.length >= 1,
            "draft links the saved file": Boolean(draft && file && links(body, file)),
            "draft payload row 300 vs 1,200 kg": KG300.test(strip(body)) && KG1200.test(strip(body)),
            "nothing sent": nothingSent(ctx),
            "Jira/Confluence unchanged": same(ctx.after.atlassian, ctx.before.atlassian),
          }, { file: file ? { id: file.id, name: file.name, path: file.path } : null, fileExcerpt: content.slice(0, 1500), draftCount: drafts.length, draftExcerpt: strip(body).slice(0, 1200) },
          ["comparison file saved in Drive", "unsent reply draft in the Blue Harbor thread", "nothing sent"]);
        },
        T04: async (ctx) => {
          const file = changedFiles(ctx).find((entry) => entry.name === "Acme account analysis.md");
          const content = file ? await textFile(file) : "";
          const mixed = /(?:ARR|annual recurring revenue)[^\n|]{0,30}\$?\s?(?:1\.38|0\.41)\s*M/i.test(content);
          return judge({
            "'Acme account analysis.md' saved in Drive": Boolean(file),
            "ARR $1.46M (Blue Harbor) and $1.10M (Northwind)": /1\.46\s*M/i.test(content) && /1\.10?\s*M/i.test(content),
            "orders 4 / $1.38M and 2 / $0.41M": /1\.38\s*M/i.test(content) && /0\.41\s*M/i.test(content),
            "ARR not mixed with order value": Boolean(content) && !mixed,
            "relationship, growth and churn covered": /relationship/i.test(content) && /growth/i.test(content) && /churn/i.test(content),
            "cites both account plans": /Account plan: Northwind|Northwind[^\n]{0,40}(?:plan|confluence)/i.test(content) && /Account plan: Blue Harbor|Blue Harbor[^\n]{0,40}(?:plan|confluence)/i.test(content),
            "nothing sent / no Jira-Confluence change": nothingSent(ctx) && same(ctx.after.atlassian, ctx.before.atlassian),
          }, { file: file ? { id: file.id, path: file.path } : null, fileExcerpt: content.slice(0, 2000) }, ["'Acme account analysis.md' saved in Drive"]);
        },
        T05: async (ctx) => {
          const file = changedFiles(ctx).find((entry) => entry.name === "Acme account analysis.pptx");
          let deck: ReturnType<typeof inspectPptx> = { zip: false, slides: [] };
          if (file) {
            const path = join(checks, "guide-T05-downloaded.pptx");
            await writeFile(path, await download(browser, String(file.id)), { mode: 0o600 });
            deck = inspectPptx(path);
          }
          const all = deck.slides.map((slide) => slide.text).join(" ");
          const thin = deck.slides.filter((slide) => slide.text.replace(/\s+/g, " ").trim().length < 80).map((slide) => slide.name);
          return judge({
            "'Acme account analysis.pptx' saved in Drive": Boolean(file),
            "real .pptx (zip with slides)": deck.zip && deck.slides.length > 0,
            "exact ARR and order figures kept": /1\.46\s*M/i.test(all) && /1\.10?\s*M/i.test(all) && /1\.38\s*M/i.test(all) && /0\.41\s*M/i.test(all),
            "every slide has substantive content (>=80 chars)": deck.slides.length > 0 && thin.length === 0,
            "reply names slides needing a visual check": /slide\s*\d+|slides?\s+\d+/i.test(ctx.reply) && /visual|layout|check|review/i.test(ctx.reply),
            "nothing sent": nothingSent(ctx),
          }, { file: file ? { id: file.id, path: file.path } : null, slideCount: deck.slides.length, thinSlides: thin, slides: deck.slides.map((slide) => ({ name: slide.name, chars: slide.text.length, start: slide.text.slice(0, 160) })) },
          ["'Acme account analysis.pptx' saved in Drive", "real .pptx (zip with slides)"]);
        },
        T06: async (ctx) => {
          const old = new Set(nested(ctx.before.atlassian, "jira", "issues").map((issue) => issue.key));
          const created = nested(ctx.after.atlassian, "jira", "issues").filter((issue) => !old.has(issue.key));
          const issue = created.find((entry) => /Project XYZ/i.test(canonical(entry.summary))) ?? created[0];
          return judge({
            "exactly one new Jira issue": created.length === 1,
            "in DOC project": Boolean(issue && /^DOC$/i.test(String(record(issue.project) ? issue.project.key : issue.project))),
            "type Task": Boolean(issue && /Task/i.test(canonical(issue.issuetype))),
            "summary exact": Boolean(issue && String(issue.summary) === "Update documentation for Project XYZ"),
            "assigned to Nora Patel": Boolean(issue && /nora/i.test(canonical(issue.assignee))),
            "reply confirms the key": Boolean(issue && ctx.reply.includes(String(issue.key))),
            "Outlook/Drive unchanged": same(ctx.after.microsoft, ctx.before.microsoft),
          }, { created: created.map((entry) => ({ key: entry.key, project: entry.project, issuetype: entry.issuetype, summary: entry.summary, assignee: entry.assignee })) },
          ["exactly one new Jira issue", "in DOC project", "assigned to Nora Patel"]);
        },
        T09: async (ctx) => judge({
          "says no dog policy was found": /couldn.t find|could not find|didn.t find|did not find|no (?:explicit |specific |published |written |formal |documented )?(?:dog|pet)[- ]?(?:policy|rule|guidance)|not (?:specified|covered|stated|found|mentioned|addressed)|does(?:n.t| not) (?:mention|address|specify|say|cover|include)|no policy|silent/i.test(ctx.reply),
          "does not invent a rule": !/(?<!whether |if |that )dogs? (?:are|is) (?:allowed|permitted|welcome|prohibited|banned|not allowed|not permitted)|(?<!whether |if )you (?:can|may|cannot|can.t) bring (?:your |a )?dog/i.test(ctx.reply),
          "cites Employee Handbook and Working at the office": /Employee Handbook/i.test(ctx.reply) && /Working at the office/i.test(ctx.reply),
          "suggests a People Ops question": /People Ops/i.test(ctx.reply),
          "no workplace mutation": same(ctx.after.microsoft, ctx.before.microsoft) && same(ctx.after.atlassian, ctx.before.atlassian),
        }, {}, ["does not invent a rule", "no workplace mutation"]),
        T11: async (ctx) => {
          const events = rows(ctx.after.microsoft.events).filter((event) => event.subject === "Acme Atlas review");
          const beforeCount = rows(ctx.before.microsoft.events).filter((event) => event.subject === "Acme Atlas review").length;
          const event = events[0];
          const start = instant({ dateTime: "2026-10-20T11:00:00", timeZone: "America/Los_Angeles" });
          const end = instant({ dateTime: "2026-10-20T11:45:00", timeZone: "America/Los_Angeles" });
          const people = event ? attendeeSet(event).join(" ") : "";
          return judge({
            "exactly one 'Acme Atlas review' (no duplicate)": events.length === 1 && beforeCount === 0,
            "Oct 20 2026 11:00-11:45 America/Los_Angeles": Boolean(event && instant(event.start) === start && instant(event.end) === end),
            "Nora Patel and Priya Shah attending": /nora@acme\.test/.test(people) && /priya@acme\.test/.test(people),
            "in Acme lab B": Boolean(event && /Acme lab B/i.test(canonical(event.location))),
            "note kept": Boolean(event && /Review Atlas 2 and Atlas Lift comparison/i.test(canonical(event.body))),
            "no mail sent / Jira-Confluence unchanged": nothingSent(ctx) && same(ctx.after.atlassian, ctx.before.atlassian),
          }, { beforeCount, events: events.map((entry) => ({ id: entry.id, start: entry.start, end: entry.end, location: entry.location, attendees: attendeeSet(entry) })) },
          ["exactly one 'Acme Atlas review' (no duplicate)", "Oct 20 2026 11:00-11:45 America/Los_Angeles"]);
        },
        T12: async (ctx) => {
          const original = pages(ctx.before.atlassian).find((page) => page.title === "Working at the office");
          const page = original ? pages(ctx.after.atlassian).find((entry) => entry.id === original.id) : undefined;
          const was = original ? strip(String(original.body)) : "", now = page ? strip(String(page.body)) : "";
          const sentences = was.split(/(?<=[.:])\s+/).filter((sentence) => sentence.length > 12);
          const kept = sentences.filter((sentence) => now.includes(sentence)).length;
          const oldComments = new Set(rows(original?.comments).map((comment) => comment.id));
          const newComments = rows(page?.comments).filter((comment) => !oldComments.has(comment.id));
          const drafts = newDrafts(ctx).filter((draft) => draft.conversationId === "thread-blueharbor");
          const body = drafts[0] ? bodyOf(drafts[0]) : "";
          return judge({
            "new page version saved": Boolean(original && page && version(page) > version(original)),
            "existing content preserved": sentences.length > 0 && kept === sentences.length,
            "note added": /dog-policy confirmation remains with People Ops/i.test(now),
            "review comment added": newComments.some((comment) => /Workshop review complete/i.test(canonical(comment.body))),
            "no replacement page created": pages(ctx.after.atlassian).length === pages(ctx.before.atlassian).length,
            "unsent draft in Blue Harbor thread linking the page": drafts.length >= 1 && Boolean(original && body.includes(String(original.id))),
            "nothing sent": nothingSent(ctx),
          }, { pageVersion: [original ? version(original) : null, page ? version(page) : null], sentencesKept: `${kept}/${sentences.length}`, newComments: newComments.map((comment) => strip(canonical(comment.body)).slice(0, 200)), draftExcerpt: strip(body).slice(0, 800) },
          ["new page version saved", "existing content preserved", "nothing sent"]);
        },
        T10: async (ctx) => {
          const files = changedFiles(ctx);
          const file = files.find((entry) => /morning news/i.test(String(entry.path ?? "")) || /morning news/i.test(canonical(entry.parentReference)));
          const content = file && /\.(md|txt|html?)$/i.test(String(file.name)) ? await textFile(file) : "";
          const drafts = newDrafts(ctx);
          const countries = ["France", "United States", "Germany", "Japan"].filter((country) => content.includes(country));
          return judge({
            "digest saved under OneDrive › Morning news": Boolean(file),
            "covers all four countries": countries.length === 4,
            "items carry outlet and source link": /outlet/i.test(content) && /https?:\/\//.test(content),
            "unsent Outlook draft created": drafts.length >= 1,
            "schedule labeled simulated": /simulated/i.test(ctx.reply) || /simulated/i.test(content),
            "nothing sent": nothingSent(ctx),
          }, { file: file ? { name: file.name, path: file.path } : null, countries, fileExcerpt: content.slice(0, 1500), drafts: drafts.map((draft) => ({ subject: draft.subject, excerpt: strip(bodyOf(draft)).slice(0, 300) })), filesChanged: files.map((entry) => entry.path ?? entry.name) },
          ["digest saved under OneDrive › Morning news", "nothing sent"]);
        },
        T02: async (ctx) => {
          const after = await denList("/v1/workflows");
          const saved = after.items.filter((item) => /Acme product comparison/i.test(String(item.title ?? item.name ?? "")));
          const isNew = saved.some((item) => !ctx.workflowsBefore.some((old) => old.configObjectId === item.configObjectId));
          const runs = await denList("/v1/workflow-runs");
          const taskRuns = runs.items.filter((run) => run.status === "succeeded" && Date.parse(String(run.createdAt)) >= ctx.begin);
          return judge({
            "Workflow 'Acme product comparison' saved in Library": saved.length >= 1,
            "saved during this task": isNew,
            "saved version rerun (succeeded runs during the task; reply names cold-storage)": taskRuns.length >= 2 && /cold-storage/i.test(ctx.reply),
            "reply assesses both products with payloads": /Atlas 2/i.test(ctx.reply) && /Atlas Lift/i.test(ctx.reply) && KG300.test(ctx.reply) && KG1200.test(ctx.reply),
            "no workplace mutation": same(ctx.after.microsoft, ctx.before.microsoft) && same(ctx.after.atlassian, ctx.before.atlassian),
          }, { workflowsStatus: after.status, saved: saved.map((item) => ({ configObjectId: item.configObjectId, title: item.title })), runsStatus: runs.status, succeededRunsDuringTask: taskRuns.length },
          ["Workflow 'Acme product comparison' saved in Library"]);
        },
      };

      for (const id of ["T01", "T04", "T05", "T06", "T09", "T11", "T12", "T10", "T02"]) {
        const spent = (await used()) - spendStart;
        if (spent > capMicroUsd - reserveMicroUsd) { tasks.push({ id, verdict: "SKIPPED", reason: `guide spend ${spent} micro-USD near the $2.50 cap` }); await save(); continue; }
        const prompt = guidePrompt(guide, id);
        const entry: Row = { id, prompt, verdict: "FAIL" };
        tasks.push(entry);
        const begin = Date.now();
        let reply = "";
        let before: { microsoft: Row; atlassian: Row } | null = null;
        let usedBefore = 0, workflowsBefore: Row[] = [];
        try {
          await foregroundWorkshopDesktop(browser, desktop);
          await freshComposer(desktop, modelId);
          before = await workplaceState(browser);
          workflowsBefore = id === "T02" ? (await denList("/v1/workflows")).items : [];
          usedBefore = await used();
          await sendComposerMessage(desktop, prompt);
          await waitFor(desktop, browserScript((pattern) => Boolean(document.querySelector('[data-message-role="assistant"]'))
            || [...document.querySelectorAll("button")].some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()))
            || /Question \d+ of \d+/.test(document.body.innerText), [STOP.source]), { timeoutMs: 120_000, label: `${id} started` });
          const { questions, permissions } = await settleTask(desktop, id, begin, taskTimeoutMs, true);
          Object.assign(entry, { questions, permissions });
        } catch (error) {
          entry.error = error instanceof Error ? error.message.slice(0, 1500) : String(error);
          await control(desktop, "composer.stop").catch(() => {});
          await waitIdle(desktop, 60_000, `${id} stopped`).catch(() => {});
        }
        entry.seconds = Math.round((Date.now() - begin) / 1000);
        reply = await waitForAssistantReply(desktop, { timeoutMs: 15_000 }).then((result) => result.text, () => "");
        entry.reply = reply;
        await capture(desktop, join(checks, `guide-${id}.png`)).catch(() => {});
        try {
          assert.ok(before, "Task never started");
          const after = await workplaceState(browser);
          entry.costMicroUsd = (await used()) - usedBefore;
          entry.workplaceCalls = [...auditSince(after.microsoft, auditCursor(before.microsoft)), ...auditSince(after.atlassian, auditCursor(before.atlassian))]
            .map((call) => `${String(call.name)}:${String(call.status)}`);
          const check = checksById[id]; assert.ok(check, `No check for ${id}`);
          const result = await check({ begin, reply, before, after, workflowsBefore });
          Object.assign(entry, result);
          if (entry.error && result.verdict === "PASS") Object.assign(entry, { verdict: "PARTIAL", reason: `outcome met but run errored: ${String(entry.error).slice(0, 200)}` });
        } catch (error) {
          Object.assign(entry, { verdict: "FAIL", reason: entry.error ? `run error: ${String(entry.error).slice(0, 300)}` : `check error: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` });
        }
        await save();
        console.log(`${String(entry.verdict)} guide ${id} (${String(entry.seconds)}s, ${(Number(entry.costMicroUsd ?? 0) / 1e6).toFixed(3)} USD) ${String(entry.reason)}`);
      }

      // Personal reset back to the pre-guide state.
      const result = await evalIn(browser, async () => {
        const response = await fetch("/_workshop/reset", { method: "POST", redirect: "manual" });
        return { status: response.status, type: response.type };
      });
      const reset = await workplaceState(browser);
      const resetFacts = {
        resetAccepted: record(result) && (result.status === 303 || result.type === "opaqueredirect"),
        microsoftEqualsBaseline: same(reset.microsoft, baseline.microsoft),
        atlassianEqualsBaseline: same(reset.atlassian, baseline.atlassian),
      };
      await capture(browser, join(checks, "guide-reset.png")).catch(() => {});
      await foregroundWorkshopDesktop(browser, desktop);
      await freshComposer(desktop, modelId).catch(() => {});
      const spendEnd = await used();
      return await finish(resetFacts.resetAccepted && resetFacts.microsoftEqualsBaseline && resetFacts.atlassianEqualsBaseline,
        { reset: resetFacts, totalCostMicroUsd: spendEnd - spendStart, usedMicroUsdAfter: spendEnd, summary: tasks.map((task) => ({ id: task.id, verdict: task.verdict, seconds: task.seconds, costMicroUsd: task.costMicroUsd, reason: task.reason })) });
    }

    // Model-backed commands start from a fresh task on the workshop model.
    await foregroundWorkshopDesktop(browser, desktop);
    await freshComposer(desktop, modelId);
    const before = await verifyMember(member, orgId, memberId);
    if (command === "task") {
      await sendComposerMessage(desktop, "Using the connected workshop tools only (no shell), find the latest Northwind pilot email and tell me in under 80 words whether the pilot is production-ready and what is still pending. Do not change anything.");
      await waitForAssistantReply(desktop, { timeoutMs: 300_000 });
      await waitIdle(desktop, 300_000, "task finished");
      const reply = await waitForAssistantReply(desktop, { timeoutMs: 5_000 });
      const after = await verifyMember(member, orgId, memberId);
      const passed = /northwind/i.test(reply.text) && Number(after.usedMicroUsd) > Number(before.usedMicroUsd ?? 0);
      return await finish(passed, { reply: reply.text, usedMicroUsdBefore: before.usedMicroUsd, usedMicroUsdAfter: after.usedMicroUsd });
    }
    if (command === "steer") {
      const marker = `STEERED-${Date.now().toString(36).toUpperCase()}`;
      await sendComposerMessage(desktop, "Using the connected workshop tools only (no shell), review Northwind across Outlook, Jira and Confluence one service at a time, and write a detailed summary of each. Do not change anything.");
      await waitFor(desktop, browserScript((pattern) => [...document.querySelectorAll("button")]
        .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()) && !button.disabled), [STOP.source]),
        { timeoutMs: 60_000, label: "task is running" });
      const usersBefore = await userMessages(desktop);
      await writeComposerText(desktop, `Change of plan: stop reviewing other services. Answer in one sentence and end with the exact word ${marker}.`);
      const steeredWhileBusy = await busy(desktop);
      await pressCtrlEnter(desktop);
      await waitFor(desktop, browserScript((count) => document.querySelectorAll('[data-message-role="user"]').length > count, [usersBefore]),
        { timeoutMs: 30_000, label: "steer message accepted mid-task" });
      await waitIdle(desktop, 300_000, "steered task finished");
      const reply = await waitForAssistantReply(desktop, { timeoutMs: 5_000 });
      const composer = await readComposerState(desktop);
      return await finish(steeredWhileBusy && reply.text.includes(marker), { marker, steeredWhileBusy, reply: reply.text, draftLeft: composer.draftText });
    }
    if (command === "stop") {
      await sendComposerMessage(desktop, "Using the connected workshop tools only (no shell), review every Northwind email, Jira issue and Confluence page in detail. Do not change anything.");
      await waitFor(desktop, browserScript((pattern) => [...document.querySelectorAll("button")]
        .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()) && !button.disabled), [STOP.source]),
        { timeoutMs: 60_000, label: "task is running" });
      const stopAt = Date.now();
      await control(desktop, "composer.stop");
      await waitIdle(desktop, 60_000, "run stopped");
      const stoppedSeconds = Math.round((Date.now() - stopAt) / 1000);
      await freshComposer(desktop, modelId);
      const composer = await readComposerState(desktop);
      return await finish(composer.composerEditable && !composer.modelUnavailable, { stoppedSeconds, composerUsableAfterStop: composer.composerEditable });
    }
  } catch (error) {
    const spend = command === "workshop" ? await verifyMember(member, orgId, memberId).then((bucket) => ({ usedMicroUsdAfter: bucket.usedMicroUsd }), () => ({})) : {};
    await finish(false, { ...spend, error: error instanceof Error ? error.message.slice(0, 3000) : String(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
