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
 * A cloud Den whose platform admin has not turned on sandbox organizations yet, the fictional workplace service in
 * its no-password mode (each browser gets its own private copy), and three people who belong to another company's
 * organization: two who join the sandbox and one who arrives after its seats are taken.
 */
export async function sandboxOrganizationsWorld(seed: Seed) {
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
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("The fictional workplace service did not become healthy");
      await pause();
    }

    const den = await seed.den({
      web: true,
      env: { DEN_DEPLOYMENT: "cloud", DEN_ALLOW_PRIVATE_MCP_URLS: "1", INFERENCE_FREE_ENABLED: "true", RESEND_API_KEY: "", SMTP_HOST: "" },
      org: { name: "Platform team", admin: { name: "Platform administrator" }, members: { avery: { name: "Avery Trial" }, riley: { name: "Riley Trial" }, casey: { name: "Casey Late" } } },
    });
    const { avery, riley, casey } = den.members;
    if (!avery || !riley || !casey) throw new Error("The trial people were not seeded.");
    const viewport = { width: 1280, height: 900 };
    const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/sandbox-orgs", headless: true, viewport });
    const webAvery = await seed.web({ den, signedInAs: avery, startPath: "/dashboard", headless: true, viewport });
    // Riley already has an OpenWork account but opens the link signed out, as most invitees do.
    const webRiley = await seed.web({ den, startPath: "/", headless: true, viewport });
    const webCasey = await seed.web({ den, signedInAs: casey, startPath: "/dashboard", headless: true, viewport });
    const anonymous = await seed.web({ den, startPath: "/join-sandbox?token=unknown", headless: true, viewport });
    const people = { avery, riley, casey };
    type Person = keyof typeof people;

    return {
      den, origin, admin, webAvery, webRiley, webCasey, anonymous,
      rileyLogin: { email: riley.email, password: riley.password },
      async sandboxes() {
        const result = await seed.api(den.admin, "/v1/admin/sandbox-orgs");
        if (!result.response.ok) throw new Error(`Sandbox list failed (${result.response.status}).`);
        return sandboxListSchema.parse(result.body);
      },
      /** Whether Den offers the sandbox owner Free Auto in this organization (closed or expired sandboxes get none). */
      async freeAutoOffered(organizationId: string) {
        const result = await seed.api(den.admin, "/v1/inference/access", { headers: { "x-openwork-org-id": organizationId } });
        if (!result.response.ok) throw new Error(`Auto access read failed (${result.response.status}).`);
        const access = record(result.body) && record(result.body.access) ? result.body.access : null;
        return access?.reason !== "admin_disabled";
      },
      async membership(person: Person, organizationId: string) {
        const result = await seed.api(people[person], "/v1/org", { headers: { "x-openwork-org-id": organizationId } });
        const member = record(result.body) && record(result.body.currentMember) ? result.body.currentMember : null;
        return { status: result.response.status, role: member && typeof member.role === "string" ? member.role : null };
      },
      async connections(person: Person, organizationId: string) {
        const result = await seed.api(people[person], "/v1/mcp-connections?scope=usable", { headers: { "x-openwork-org-id": organizationId } });
        return record(result.body) ? rows(result.body.connections) : [];
      },
      async oauthStart(person: Person, organizationId: string, connectionId: string) {
        const result = await seed.api(people[person], `/v1/mcp-connections/${connectionId}/connect/start`, { headers: { "x-openwork-org-id": organizationId } });
        if (!result.response.ok || !record(result.body) || typeof result.body.authorizeUrl !== "string") throw new Error(`Den OAuth start: HTTP ${result.response.status}`);
        return result.body.authorizeUrl;
      },
      async memberAccess() {
        const read = await seed.api(avery, "/v1/admin/sandbox-orgs");
        const write = await seed.api(avery, "/v1/admin/sandbox-orgs", { method: "POST", body: JSON.stringify({ name: "Not allowed", connectorBaseUrl: null, days: 1, memberLimit: 1, allowedEmailDomains: [] }) });
        return { read: read.response.status, write: write.response.status };
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
