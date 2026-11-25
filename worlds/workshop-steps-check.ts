/**
 * Runs the attendee hands-on handout (worlds/workshop-handout.md prompts) on one
 * live workshop seat through the real desktop UI, recording each step's reply,
 * duration, cost and a screenshot. It reports what actually happened; it does
 * not decide pass/fail for open-ended steps (automation, live app).
 *
 *   node worlds/workshop-steps-check.ts <seat-dir> [colleague-email]
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachSurface, browserScript } from "../evals/packages/cdp/src/index.ts";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { control, evalIn, waitFor } from "../evals/packages/behaviors/src/desktop.ts";
import { sendComposerMessage, waitForAssistantReply } from "../evals/packages/behaviors/src/composer.ts";
import type { DenSession } from "../evals/packages/behaviors/src/den.ts";
import { defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { parsePrivatePreview } from "../evals/packages/hosts/src/private-web-preview.ts";
import { foregroundWorkshopDesktop, WORKPLACE_ORIGIN } from "./lib/workshop-browser.ts";
import { freshComposer, verifyMember } from "./workshop-fleet.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, field: string): string {
  assert.ok(record(value) && typeof value[field] === "string" && value[field], `control.json is missing ${field}`);
  return String(value[field]);
}
const STOP = "^(stop|stop task|stop generating)$";

export const STEPS = [
  { id: "2-hi", fresh: true, prompt: "Hi! In two sentences, what can you help me with in this workspace?" },
  { id: "4-one-connector", fresh: true, prompt: "Using Workshop Outlook, find my most recent email. Summarize it in 3 bullet points and tell me who sent it and when. Don't change anything." },
  { id: "5-three-connectors", fresh: true, prompt: "Prepare me for my Northwind Logistics account review. Use Workshop Outlook for the latest emails, Workshop Jira for open issues, and Workshop Confluence for the account plan. Give me a one-page brief with: current status, open risks, next steps, and a link to each source you used. Don't change anything." },
  { id: "6-pptx", fresh: false, prompt: "Turn that brief into a 3-slide PowerPoint: a title slide, a status-and-risks slide, and a next-steps slide. Save it to my Workshop Drive as \"Northwind-brief.pptx\" and give me the link." },
  { id: "7-skill", fresh: true, prompt: "Create a skill called \"Account brief\" that, for any customer I name, reads Workshop Outlook, Workshop Jira and Workshop Confluence and writes a one-page brief with status, open risks, next steps and source links. Save it so I can reuse it, then show me how to run it." },
  // Reuse: the second time, the saved skill does the work from one short line.
  { id: "8-reuse-skill", fresh: true, prompt: "Run Account brief for Blue Harbor Foods." },
  // Run on the colleague's seat: the skill they were given.
  { id: "9-colleague-runs-shared-skill", fresh: true, prompt: "Run Account brief for Blue Harbor Foods." },
] as const;

async function attach(id: string, port: number, kind: "chrome" | "electron") {
  const result = await defaultDaytonaExec(["preview-url", id, "-p", String(port), "--expires", "3600"], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, "Private control endpoint could not be minted");
  return attachSurface({ name: `workshop-steps-${kind}`, hostKind: "daytona", sandboxId: id, kind, cdpUrl: parsePrivatePreview(result.stdout, id, port).browserOrigin });
}
async function capture(surface: Surface, path: string) {
  const image: unknown = await surface.client.send("Page.captureScreenshot", { format: "png" });
  if (record(image) && typeof image.data === "string") await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
}
async function waitIdle(desktop: Surface, timeoutMs: number) {
  await waitFor(desktop, browserScript((pattern) => ![...document.querySelectorAll("button")]
    .some((button) => new RegExp(pattern, "i").test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()))
    && !document.querySelector('[data-status="pending"], [data-status="running"]'), [STOP]), { timeoutMs, label: "task finished" });
}
/** Answer an agent multiple-choice question the way an attendee would: the Recommended option. */
async function answerRecommended(desktop: Surface): Promise<string | null> {
  const picked = await evalIn(desktop, () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => /\(Recommended\)/.test(entry.textContent ?? "") && !entry.disabled);
    if (!button) return null;
    const label = (button.textContent ?? "").trim(); button.click(); return label;
  });
  return typeof picked === "string" ? picked : null;
}

export async function main(argv = process.argv.slice(2)) {
  const [seatDir, colleague] = argv;
  assert.ok(seatDir, "Usage: node worlds/workshop-steps-check.ts <seat-dir> [colleague-email]");
  const seat: unknown = JSON.parse(await readFile(join(seatDir, "control.json"), "utf8"));
  assert.ok(record(seat) && record(seat.memberLogin));
  const login = seat.memberLogin;
  const member: DenSession = { email: text(login, "email"), password: text(login, "password"), token: text(login, "token"), apiUrl: text(login, "apiUrl"), webUrl: text(login, "webUrl") };
  const orgId = text(seat, "orgId"), memberId = text(seat, "memberId"), modelId = text(seat, "modelId"), desktopId = text(seat, "desktopSandbox");
  const out = join(seatDir, "checks", "steps");
  await mkdir(out, { recursive: true, mode: 0o700 });
  await using desktop = await attach(desktopId, 9825, "electron");
  await using browser = await attach(desktopId, 9222, "chrome");
  await foregroundWorkshopDesktop(browser, desktop);
  const results: Record<string, unknown>[] = [];
  const save = () => writeFile(join(out, "steps.json"), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600 });

  // 1. Signed in.
  const auth = await control(desktop, "auth.status");
  results.push({ id: "1-signed-in", ok: record(auth) && record(auth.user) && auth.user.email === member.email, user: record(auth) && record(auth.user) ? auth.user.name ?? auth.user.email : null });
  await capture(desktop, join(out, "1-signed-in.png")); await save();

  // 3. Connectors as the attendee sees them in Library.
  try {
    await evalIn(desktop, () => { const link = [...document.querySelectorAll<HTMLElement>("a, button")].find((entry) => (entry.textContent ?? "").trim() === "Library"); link?.click(); return Boolean(link); });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await capture(desktop, join(out, "3-library.png"));
    const library = await evalIn(desktop, () => document.body.innerText);
    const page = typeof library === "string" ? library : "";
    const names = ["Workshop Outlook", "Workshop Calendar", "Workshop Drive", "Workshop Jira", "Workshop Confluence"];
    results.push({ id: "3-library", visible: names.filter((name) => page.includes(name)), libraryText: page.slice(0, 1500) });
    // Look for a Connectors/Connections tab inside Library.
    const tab = await evalIn(desktop, () => { const entry = [...document.querySelectorAll<HTMLElement>("a, button, [role=tab]")].find((node) => /^(connectors|connections)$/i.test((node.textContent ?? "").trim())); entry?.click(); return entry?.textContent?.trim() ?? null; });
    if (tab) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await capture(desktop, join(out, "3-library-connectors.png"));
      const text2 = await evalIn(desktop, () => document.body.innerText);
      const page2 = typeof text2 === "string" ? text2 : "";
      results.push({ id: "3-library-tab", tab, visible: names.filter((name) => page2.includes(name)), text: page2.slice(0, 1500) });
    }
  } catch (error) { results.push({ id: "3-library", error: error instanceof Error ? error.message.slice(0, 500) : String(error) }); }
  await save();

  const only = process.env.WORKSHOP_STEPS?.split(",").map((value) => value.trim()).filter(Boolean);
  const chosen = only?.length ? STEPS.filter((step) => only.some((prefix) => step.id.startsWith(prefix))) : [...STEPS];
  // Sharing follows the skill step, in the same conversation.
  const steps = chosen.flatMap((step) => step.id === "7-skill" && colleague
    ? [step, { id: "7b-share-skill", fresh: false, prompt: `Share the "Account brief" skill with my colleague ${colleague} so they can use it too.` }] // colleague: a display name such as "Attendee 18", as in the handout
    : [step]);
  for (const step of steps) {
    const started = Date.now();
    const before = await verifyMember(member, orgId, memberId).catch(() => null);
    const entry: Record<string, unknown> = { id: step.id, prompt: step.prompt };
    try {
      if (step.fresh) await freshComposer(desktop, modelId);
      await sendComposerMessage(desktop, step.prompt);
      const deadline = Date.now() + 480_000;
      const questions: string[] = [];
      for (;;) {
        try { await waitIdle(desktop, 20_000); break; }
        catch {
          const picked = await answerRecommended(desktop);
          if (picked) questions.push(picked);
          if (Date.now() > deadline) throw new Error("Step exceeded 8 minutes");
        }
      }
      const reply = await waitForAssistantReply(desktop, { timeoutMs: 10_000 });
      const after = await verifyMember(member, orgId, memberId).catch(() => null);
      Object.assign(entry, { seconds: Math.round((Date.now() - started) / 1000), reply: reply.text.slice(0, 2500), questionsAnswered: questions,
        costUsd: before && after ? (Number(after.usedMicroUsd) - Number(before.usedMicroUsd ?? 0)) / 1e6 : null });
      if (step.id === "6-pptx") {
        await evalIn(browser, browserScript((origin) => { if (location.origin !== origin) location.href = `${origin}/`; return true; }, [WORKPLACE_ORIGIN]));
        await waitFor(browser, browserScript((origin) => location.origin === origin && document.readyState === "complete", [WORKPLACE_ORIGIN]), { timeoutMs: 60_000, label: "workplace" });
        const files = await evalIn(browser, async () => ((await (await fetch("/_workshop/state/microsoft")).json()).files ?? []).map((file: { name?: string; size?: number }) => `${file.name}`).filter((name: string) => /\.pptx$/i.test(name)));
        entry.pptxInDrive = files;
        await foregroundWorkshopDesktop(browser, desktop);
      }
    } catch (error) {
      Object.assign(entry, { seconds: Math.round((Date.now() - started) / 1000), error: error instanceof Error ? error.message.slice(0, 800) : String(error) });
      await control(desktop, "composer.stop").catch(() => {});
    }
    await capture(desktop, join(out, `${step.id}.png`)).catch(() => {});
    results.push(entry); await save();
    console.log(`${step.id}: ${entry.error ? "ERROR " + String(entry.error).slice(0, 120) : `${entry.seconds}s $${entry.costUsd}`}`);
  }
  console.log(`receipt ${join(out, "steps.json")}`);
}

if (import.meta.main) await main();
