import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { isolatedRedis } from "./isolated-redis.ts";
import { bootWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function list(value: unknown, key: string): Record<string, unknown>[] {
  const items = isRecord(value) ? value[key] : undefined;
  return Array.isArray(items) ? items.filter(isRecord) : [];
}
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Wednesday and Thursday of this week at 18:00 UTC: inside Workbot Calendar's default work week in any US or EU zone. */
function thisWeek(weekday: 3 | 4): Date {
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  return new Date(monday.getTime() + (weekday - 1) * 86_400_000 + 18 * 3_600_000);
}

/**
 * Real Workbot, Den, runner and AI Gateway, with Open Outlook, Open Calendar and Open Drive as two people's Microsoft
 * 365 through Den's ordinary connector. Each person has their own workplace backend and their own signed-in browser.
 * The model is the scripted workplace agent (worlds/lib/workplace-agent.ts), so the tool path is real and repeatable.
 */
export async function workbotOpenWorkplace(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  try {
    const redis = resources.use(await isolatedRedis());
    const world = await bootWorkbot(resources, undefined, { live: false, openWorkplace: true, denEnv: { DATABASE_REDIS_URL: redis.url } });
    const workplace = world.workplace;
    const teammate = world.teammate;
    if (!workplace || !teammate) throw new Error("The Open Workplace world did not start its people");
    async function browser(name: string, person?: { email: string; password: string }) {
      const session = await signInWorkbot(world, person ? { person } : {});
      const web = resources.use(await chrome({ host: place.host(), name, headless: true }));
      // Workbot's own session cookie for this person, as its sign-in callback sets it.
      for (const pair of session.cookie.split("; ")) {
        const at = pair.indexOf("=");
        await web.client.send("Network.setCookie", { url: world.workbotUrl, name: pair.slice(0, at), value: pair.slice(at + 1), httpOnly: true, sameSite: "Lax" });
      }
      return web;
    }
    const web = await browser("workbot-alex");
    const caseyWeb = await browser("workbot-casey", teammate);
    const graph = async (handle: string, path: string, init: RequestInit = {}): Promise<unknown> => {
      const response = await fetch(`${workplace.person(handle).backend.baseUrl}/v1.0${path}`, {
        ...init, headers: { authorization: "Bearer open-workplace-token", "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Open Workplace ${path}: HTTP ${response.status}`);
      return response.status === 204 ? null : await response.json();
    };
    const wednesday = thisWeek(3);
    const thursday = thisWeek(4);
    return {
      web, caseyWeb, url: world.workbotUrl,
      alex: workplace.person("alex").urls, casey: workplace.person("casey").urls,
      wednesday, thursday,
      /** Adds an event to a person's Open Calendar through its Graph API, the same call its New event form makes. */
      async createEvent(handle: string, subject: string, start: Date, minutes: number) {
        await graph(handle, "/me/events", { method: "POST", body: JSON.stringify({ subject, start: { dateTime: start.toISOString(), timeZone: "UTC" }, end: { dateTime: new Date(start.getTime() + minutes * 60_000).toISOString(), timeZone: "UTC" } }) });
      },
      /** What a person's Open Calendar holds for this subject, read straight from their workplace. */
      async event(handle: string, subject: string) {
        const event = list(await graph(handle, "/me/events"), "value").find((entry) => entry.subject === subject);
        // Graph wall times in UTC carry no offset (2026-11-05T18:00:00.0000000); read them as UTC instants.
        const instant = (value: unknown) => isRecord(value) && value.timeZone === "UTC" ? Date.parse(`${text(value.dateTime).replace(/(\.\d+)?Z?$/, "")}Z`) : Number.NaN;
        return event ? { start: instant(event.start), end: instant(event.end) } : null;
      },
      async drafts(handle: string) {
        return list(await graph(handle, "/me/mailFolders/drafts/messages"), "value").map((message) => ({ subject: text(message.subject), body: text(isRecord(message.body) ? message.body.content : "") }));
      },
      async files(handle: string) {
        return list(await graph(handle, "/me/drive/root/children"), "value").map((file) => text(file.name));
      },
      async fileText(handle: string, name: string) {
        const response = await fetch(`${workplace.person(handle).backend.baseUrl}/v1.0/me/drive/root:/${encodeURIComponent(name)}:/content`, { headers: { authorization: "Bearer open-workplace-token" }, signal: AbortSignal.timeout(15_000) });
        return response.ok ? await response.text() : null;
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
