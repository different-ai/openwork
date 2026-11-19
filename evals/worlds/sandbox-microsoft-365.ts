import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { sandboxListSchema } from "@openwork/types/den/sandbox-organizations";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 500));

/**
 * A cloud Den with the hosted sample work apps (the workshop gateway in its no-password mode: each browser gets its
 * own private workplace), a platform admin on /admin/sandbox-orgs, and two people who will join a sandbox from their
 * own browsers. New sandboxes include sample Microsoft 365 without a rollout override.
 */
export async function sandboxMicrosoft365World(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const origin = `http://127.0.0.1:${await allocateFreePort()}`;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/open-workplace/src/workshop.mjs", import.meta.url))], {
      env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: new URL(origin).port, PUBLIC_URL: origin, OPEN_WORKPLACE_JOIN_MODE: "automatic", OPEN_WORKPLACE_PARTICIPANTS: "[]" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume(); child.stderr.resume();
    resources.defer(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
      });
    });
    const deadline = Date.now() + 60_000;
    while (!await fetch(`${origin}/health`).then((result) => result.ok).catch(() => false)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("The sample work apps did not become healthy");
      await pause();
    }

    const den = await seed.den({
      web: true,
      env: { DEN_DEPLOYMENT: "cloud", DEN_ALLOW_PRIVATE_MCP_URLS: "1", RESEND_API_KEY: "", SMTP_HOST: "" },
      org: { name: "Platform team", admin: { name: "Platform administrator" }, members: { avery: { name: "Avery Demo" }, riley: { name: "Riley Demo" } } },
    });
    const { avery, riley } = den.members;
    if (!avery || !riley) throw new Error("The demo people were not seeded.");
    const viewport = { width: 1280, height: 900 };
    const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/sandbox-orgs", headless: true, viewport });
    const webAvery = await seed.web({ den, signedInAs: avery, startPath: "/dashboard", headless: true, viewport });
    const webRiley = await seed.web({ den, signedInAs: riley, startPath: "/dashboard", headless: true, viewport });
    const people = { avery, riley };
    type Person = keyof typeof people;
    const headers = (organizationId: string) => ({ "x-openwork-org-id": organizationId });

    return {
      den, origin, admin, webAvery, webRiley,
      async sandboxes() {
        const result = await seed.api(den.admin, "/v1/admin/sandbox-orgs");
        if (!result.response.ok) throw new Error(`Sandbox list failed (${result.response.status}).`);
        return sandboxListSchema.parse(result.body);
      },
      async connections(person: Person, organizationId: string) {
        const result = await seed.api(people[person], "/v1/mcp-connections?scope=usable", { headers: headers(organizationId) });
        return record(result.body) ? rows(result.body.connections) : [];
      },
      /** The authorize address Den sends a member's browser to when they press Connect on Microsoft 365. */
      async connectStart(person: Person, organizationId: string, connectionId: string) {
        const result = await seed.api(people[person], `/v1/oauth-providers/${connectionId}/connect/start`, { headers: headers(organizationId) });
        if (!result.response.ok || !record(result.body) || typeof result.body.authorizeUrl !== "string") throw new Error(`Den Microsoft 365 connect: HTTP ${result.response.status} ${result.text.slice(0, 200)}`);
        return result.body.authorizeUrl;
      },
      async status(person: Person, organizationId: string, connectionId: string) {
        const result = await seed.api(people[person], `/v1/oauth-providers/${connectionId}/status`, { headers: headers(organizationId) });
        return { connected: record(result.body) && result.body.connected === true, account: record(result.body) && typeof result.body.externalAccountId === "string" ? result.body.externalAccountId : null };
      },
      /** The Den route Workbot's Calendar tab and the first hello read: this week's Outlook calendar. */
      async calendar(person: Person, organizationId: string) {
        const from = new Date(Date.now() - 2 * 86_400_000).toISOString(), to = new Date(Date.now() + 7 * 86_400_000).toISOString();
        const result = await seed.api(people[person], `/v1/capabilities/microsoft-365/calendar-events?timeMin=${from}&timeMax=${to}&maxResults=100`, { headers: headers(organizationId) });
        const events = record(result.body) ? rows(result.body.events).map((event) => String(event.subject)) : [];
        return { status: result.response.status, events, message: record(result.body) && typeof result.body.message === "string" ? result.body.message : "" };
      },
      /** The Den route Workbot uses to put a meeting on the member's calendar. */
      async addMeeting(person: Person, organizationId: string, subject: string) {
        const start = new Date(); start.setUTCMinutes(0, 0, 0); start.setUTCHours(start.getUTCHours() + 1);
        const result = await seed.api(people[person], "/v1/capabilities/microsoft-365/calendar-events", { method: "POST", headers: headers(organizationId), body: JSON.stringify({ subject, start: start.toISOString(), end: new Date(start.getTime() + 30 * 60_000).toISOString(), timeZone: "UTC" }) });
        return result.response.status;
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
