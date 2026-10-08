import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "../../evals/packages/cdp/src/index.ts";
import { denFetch, type DenSession } from "../../evals/packages/behaviors/src/den.ts";
import { app } from "../../evals/packages/env/src/desktop-app.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import type { Place } from "../../evals/packages/env/src/place.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";
import { output, secret } from "../../packages/world/src/outputs.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";

/**
 * The desktop Calendar on top of the Workbot world (`preview-workbot -- --calendar`): the Acme owner's
 * Automations with two weeks of runs (seeded by seed-demo-org --automations), the automationCalendar feature on
 * for Acme, the calendar mock (evals/packages/labs/src/calendar-mock.mjs) for meetings, and a signed-in desktop
 * whose meetings layer reads the mock. Flip the desktop to real connections with
 * `localStorage.setItem("openwork.calendar.mockUrl", "off")` and a reload; nothing else changes.
 */

const MOCK_SCRIPT = new URL("../../evals/packages/labs/src/calendar-mock.mjs", import.meta.url);

export type CalendarMock = { baseUrl: string };

/** The calendar mock as a child process of this world, ready once /health answers. */
export async function startCalendarMockProcess(stack: AsyncDisposableStack, env: Record<string, string> = {}): Promise<CalendarMock> {
  const port = await allocateFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(MOCK_SCRIPT)], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let failure: Error | undefined;
  child.on("error", (error) => { failure = error; });
  const capture = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-4000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  stack.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  });
  if (child.pid) await trackResource({ kind: "process", id: String(child.pid), label: "calendar-mock", match: "calendar-mock.mjs" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw new Error(`Calendar mock failed to start: ${failure?.message ?? logs}`);
    if (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false)) return { baseUrl };
    await delay(250);
  }
  throw new Error(`Calendar mock did not become healthy: ${logs}`);
}

/** The owner's desktop, signed in to this Den, opening on the Calendar with meetings from the mock. */
export async function bootCalendarDesktop(stack: AsyncDisposableStack, input: { den: Den; place: Place; mock: CalendarMock }) {
  return stack.use(await app({
    den: input.den, place: input.place, as: "admin", enterpriseActivated: true,
    env: { VITE_DISABLE_OPENWORK_MODELS: "0", VITE_OPENWORK_CALENDAR_MOCK_URL: input.mock.baseUrl },
  }));
}

export function calendarOutputs(mock: CalendarMock, desktop: { handle: { cdpUrl: string } } | null): Record<string, WorldOutput> {
  return {
    calendarMock: output(mock.baseUrl, { group: "Calendar", note: "Den-contract calendar routes, provider upstreams and /mcp; POST /scenario {\"google\":\"expired_token\"} to try error states" }),
    calendarMockState: output(`${mock.baseUrl}/state`, { group: "Calendar", note: "The seeded meetings, as Google and Graph return them" }),
    calendarAutomations: output("5 Automations, two weeks of runs", { group: "Calendar", note: "Seeded for alex@acme.test; automationCalendar and workbotCalendar are on for Acme" }),
    ...(desktop ? {
      calendarDesktop: output("OpenWork desktop window", { group: "Calendar", note: "Open Calendar in the sidebar; meetings come from the mock" }),
      calendarCdp: secret(desktop.handle.cdpUrl, { group: "Calendar" }),
    } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Publishes an Anthropic provider (two Claude models from Den's catalog, a fixture key) to every member, so the
 * Calendar's model pickers list real providers with their logos next to the free starter and the cloud default.
 * No run reaches Anthropic: the specs only pick and save the model.
 */
export async function publishCalendarModels(admin: DenSession, organizationId: string): Promise<void> {
  const headers = { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": organizationId };
  const catalog = await denFetch(admin, "/v1/llm-provider-catalog/anthropic", { headers });
  if (!catalog.response.ok) throw new Error(`Could not read the Anthropic catalog: HTTP ${catalog.response.status}`);
  const provider = isObject(catalog.body) && isObject(catalog.body.provider) ? catalog.body.provider : null;
  const ids = (Array.isArray(provider?.models) ? provider.models : [])
    .flatMap((model) => isObject(model) && typeof model.id === "string" && !/preview|exp|latest/i.test(model.id) ? [model.id] : []);
  // One Sonnet and one Opus, so the picker shows two clearly different models.
  const modelIds = [ids.find((id) => /^claude-sonnet-4/.test(id)), ids.find((id) => /^claude-opus-4/.test(id))].filter((id): id is string => Boolean(id));
  if (modelIds.length === 0) throw new Error("The Anthropic catalog has no Claude 4 models to publish");
  const created = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Anthropic", source: "models_dev", providerId: "anthropic", modelIds, apiKey: "calendar-fixture-not-a-real-key", allMembers: true, memberIds: [], teamIds: [] }),
  });
  if (!created.response.ok) throw new Error(`Could not publish the Anthropic provider: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
}

