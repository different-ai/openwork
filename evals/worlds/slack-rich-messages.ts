import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { sandboxListSchema } from "@openwork/types/den/sandbox-organizations";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : [];
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 500));

/**
 * A cloud Den with one sandbox organization whose sample work apps include Slack ("Open Slack": the fictional
 * workshop Slack, which checks blocks against Slack's documented limits and draws them). The OpenWork Slack app is
 * installed there with the sandbox's bot, so messages `slack_send_as_bot` sends arrive on each person's own sample
 * Slack page. Alex owns the sandbox; Riley is a teammate who joins it. No model and no headless runner: the agent is
 * the MCP client the spec drives, as a chat or an Automation run would.
 */
export async function slackRichMessagesWorld(seed: Seed) {
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
      org: { name: "Platform team", admin: { name: "Alex Chen" }, members: { riley: { name: "Riley Shaw" } } },
    });
    const riley = den.members.riley;
    if (!riley) throw new Error("Riley was not seeded.");
    const people = { alex: den.admin, riley };
    type Person = keyof typeof people;

    const created = await seed.api(den.admin, "/v1/admin/sandbox-orgs", {
      method: "POST", body: JSON.stringify({ name: "Acme Robotics", connectorBaseUrl: origin, days: 2, memberLimit: 5, allowedEmailDomains: [], joinRole: "member" }),
    });
    if (!created.response.ok) throw new Error(`Sandbox create failed (${created.response.status}): ${created.text.slice(0, 300)}`);
    const listed = await seed.api(den.admin, "/v1/admin/sandbox-orgs");
    const sandbox = sandboxListSchema.parse(listed.body).sandboxes.find((entry) => entry.name === "Acme Robotics");
    if (!sandbox?.sampleSlack) throw new Error("The sandbox was created without the sample Slack.");
    const organizationId = sandbox.organizationId;
    const inSandbox = { "x-openwork-org-id": organizationId };

    const connections = async (person: Person) => {
      const result = await seed.api(people[person], "/v1/mcp-connections?scope=usable", { headers: inSandbox });
      return record(result.body) ? rows(result.body.connections) : [];
    };
    const slackConnection = (await connections("alex")).find((connection) => connection.name === "Slack");
    const slackConnectionId = typeof slackConnection?.id === "string" ? slackConnection.id : "";
    if (!slackConnectionId) throw new Error("The sandbox has no Slack connection.");

    const viewport = { width: 1180, height: 900 };
    const alexBrowser = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard", headless: true, viewport });
    const rileyBrowser = await seed.web({ den, signedInAs: riley, startPath: "/dashboard", headless: true, viewport });

    const tokens = new Map<Person, string>();
    const token = async (person: Person) => {
      const known = tokens.get(person);
      if (known) return known;
      const minted = await seed.api(people[person], "/v1/mcp/token", { method: "POST", headers: inSandbox, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
      const value = record(minted.body) && typeof minted.body.token === "string" ? minted.body.token : "";
      if (!minted.response.ok || !value) throw new Error(`Cannot mint an MCP token for ${person} (${minted.response.status}).`);
      tokens.set(person, value);
      return value;
    };
    let rpcId = 0;
    /** One MCP tool call to OpenWork Connect as that person's agent; answers the tool's structured result. */
    const call = async (person: Person, name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
        method: "POST", headers: { authorization: `Bearer ${await token(person)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`OpenWork Connect ${name}: HTTP ${response.status}`);
      const raw = await response.text();
      const data = raw.split("\n").find((line) => line.startsWith("data:"));
      const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
      if (!record(frame) || !record(frame.result)) throw new Error(`OpenWork Connect ${name}: invalid response`);
      return record(frame.result.structuredContent) ? frame.result.structuredContent : {};
    };

    return {
      den, origin, organizationId, slackConnectionId, alexBrowser, rileyBrowser, joinLink: sandbox.joinLink,
      slackPage: `${origin}/slack`,
      /** Den's own start of the person's Slack sign-in, as Your Connections opens it. */
      async oauthStart(person: Person) {
        const result = await seed.api(people[person], `/v1/mcp-connections/${slackConnectionId}/connect/start`, { headers: inSandbox });
        if (!result.response.ok || !record(result.body) || typeof result.body.authorizeUrl !== "string") throw new Error(`Slack sign-in start: HTTP ${result.response.status}`);
        return result.body.authorizeUrl;
      },
      async slackConnected(person: Person) {
        return (await connections(person)).find((connection) => connection.id === slackConnectionId)?.connectedForMe === true;
      },
      /** What the agent's capability search offers for sending as the bot: the arguments it may use. */
      async offeredArguments(person: Person) {
        const found = await call(person, "search_capabilities", { query: "slack_send_as_bot", limit: 5 });
        const match = rows(found.matches).find((entry) => entry.name === "slack_send_as_bot");
        const schema = record(match?.argumentsSchema) && record(match.argumentsSchema.properties) ? match.argumentsSchema.properties : {};
        return Object.keys(schema).sort();
      },
      /**
       * The agent sends a Slack message from the OpenWork app, as a chat or an Automation run would. When the tool
       * answers that it sent too many in a minute, the agent waits as long as the refusal says and sends once more.
       */
      async send(person: Person, body: Record<string, unknown>) {
        const first = await call(person, "execute_capability", { name: "slack_send_as_bot", body });
        if (first.error !== "rate_limited" || typeof first.retryAfterSeconds !== "number") return first;
        await new Promise<void>((resolve) => setTimeout(resolve, (Number(first.retryAfterSeconds) + 1) * 1000));
        return call(person, "execute_capability", { name: "slack_send_as_bot", body });
      },
      turnOnRichMessages: () => enableOrganizationCapabilities(seed, den.admin, { slackRichMessages: true }, organizationId),
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
