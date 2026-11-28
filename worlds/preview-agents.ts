export const summary = "Agents in the desktop app: the seeded Acme Den, the headless runner with a real model, a signed-in desktop window with Agents turned on, and three seeded agents.";
export const supportedTargets = ["local/host"];

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { app } from "../evals/packages/env/src/desktop-app.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import { bootWorkbot } from "./lib/workbot.ts";

const NAME = "preview-agents";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEZONE = "America/Los_Angeles";

/**
 * The Acme owner's agents, one per state worth looking at: with apps and a routine, with apps and no routine, and
 * with nothing yet (what "+" makes). Names and briefs are invented.
 */
const AGENTS = [
  {
    name: "Bug triage",
    brief: "Look at new bugs in Linear and the #bugs channel in Slack. Say which ones matter and why: customer impact first, then regressions. Never close or reassign an issue.",
    connectorNames: ["Linear", "Slack"],
    routines: [{
      name: "Morning bug review",
      instructions: "Read the bugs filed since the last run and post a short ranked summary with a suggested next step for each.",
      schedule: { kind: "weekly", timezone: TIMEZONE, daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
    }],
  },
  {
    name: "Meeting prep",
    brief: "Before a meeting, read the invite in Google Calendar and the related notes in Notion, then write a one-page brief: who is attending, what was decided last time, and the open questions.",
    connectorNames: ["Google Calendar", "Notion"],
    routines: [],
  },
  {
    name: "Inbox helper",
    brief: "This agent has no job yet. The person will say what they want in the chat.",
    connectorNames: [],
    routines: [],
  },
];

async function seedAgents(den: Den, orgId: string): Promise<string[]> {
  const headers = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": orgId };
  for (const { routines, ...agent } of AGENTS) {
    const created = await denFetch(den.admin, "/v1/personal-agents", {
      method: "POST", headers, body: JSON.stringify({ ...agent, idempotencyKey: `${NAME}-${agent.name}` }),
    });
    const body: unknown = created.body;
    const id = typeof body === "object" && body !== null && "agent" in body && typeof body.agent === "object" && body.agent !== null && "id" in body.agent ? body.agent.id : undefined;
    if (!created.response.ok || typeof id !== "string") throw new Error(`Could not seed the agent ${agent.name}: HTTP ${created.response.status} ${created.text.slice(0, 200)}`);
    for (const routine of routines) {
      const added = await denFetch(den.admin, `/v1/personal-agents/${id}/routines`, { method: "POST", headers, body: JSON.stringify(routine) });
      if (!added.response.ok) throw new Error(`Could not seed the routine ${routine.name}: HTTP ${added.response.status} ${added.text.slice(0, 200)}`);
    }
  }
  return AGENTS.map((agent) => agent.name);
}

/**
 * The agent chat answers from the headless runner, so this boots what preview-workbot --live boots (Den, runner,
 * real model, the runner's computer when a Freestyle key is available) and adds a desktop signed in to that Den.
 */
export async function main(): Promise<void> {
  const place = resolvePlace();
  if (place.kind !== "local") throw new Error("preview-agents runs on this computer only.");
  // The runner imports the computer package's built files; a fresh checkout has none.
  await promisify(execFile)("pnpm", ["--filter", "@openwork-ee/headless-computer", "build"], { cwd: REPO_ROOT, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  await using stack = new AsyncDisposableStack();
  const world = await bootWorkbot(stack, undefined, { live: true, agentChat: true, denEnv: { DEN_DEPLOYMENT: "cloud" }, features: { personalAgents: true, toolPermissions: true, remoteComputers: true } });
  const agents = await seedAgents(world.den, world.orgId);
  const desktop = stack.use(await app({
    den: world.den, place, as: "admin", enterpriseActivated: true,
    env: { VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_AUTOMATION_RUNNER: "on" },
  }));
  await hold({
    name: NAME,
    outputs: {
      preview: output("OpenWork desktop window", { group: "Preview", note: "Signed in as the Acme owner; Agents is in the sidebar" }),
      denWeb: output(world.den.ref.webUrl, { group: "Services" }),
      denApi: output(world.den.ref.apiUrl, { group: "Services" }),
      workbot: output(world.workbotUrl, { group: "Services" }),
      cdp: secret(desktop.handle.cdpUrl, { group: "Services" }),
      agents: output(agents.join(", "), { group: "Agents", note: "Seeded for the Acme owner; press + in the sidebar for a new one" }),
      model: output(world.model, { group: "Headless runner" }),
      computer: output(world.computer ? "on" : "off", { group: "Headless runner" }),
      email: output(world.den.admin.email, { group: "Test account" }),
      password: secret(world.den.admin.password, { group: "Test account" }),
    },
  });
}

if (import.meta.main) await main();
