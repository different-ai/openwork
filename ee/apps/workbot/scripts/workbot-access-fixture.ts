import { createServer as createHttpServer } from "node:http";
import { WORKBOT_FREE_LUNA_ID, WORKBOT_PAID_LUNA_ID, type WorkbotAccessReason } from "@openwork/types/den/workbot-settings";
import { Hono } from "hono";
import type { HeadlessModelAccess } from "@openwork-ee/headless-protocol";
import type { WorkbotActor } from "@openwork-ee/workbot-server";
import { createDen, denSessionSchema, WorkbotTurnAccessError } from "../src/server/den.js";
import { createAuth, type AppEnv } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { registerWorkbotRoutes } from "../src/server/routes.js";

/** Real Workbot request/error path. Synthetic Den grants, local runner, no external access or provisioning. */
export async function workbotAccessFixture(input: { actor: WorkbotActor; runnerUrl: string; modelAccess: HeadlessModelAccess; managed?: boolean; refusal?: WorkbotAccessReason }) {
  let paidAccessRestored = false;
  const denServer = createHttpServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const selected: unknown = raw ? JSON.parse(raw) : {};
    const free = typeof selected === "object" && selected !== null && "model" in selected && selected.model === WORKBOT_FREE_LUNA_ID;
    res.setHeader("content-type", "application/json");
    res.statusCode = input.managed || paidAccessRestored ? 200 : 403;
    res.end(JSON.stringify(input.managed || paidAccessRestored ? { token: "fixture-mcp-token", modelAccess: input.managed ? { ...input.modelAccess, protocol: free ? "openai-responses" : "openai", model: "openai/gpt-6-luna" } : input.modelAccess }
      : { error: "workbot_turn_access_denied", reason: input.refusal ?? "gateway_member_access_missing", raw: "fixture-secret-must-not-reach-browser" }));
  });
  await new Promise<void>(resolve => denServer.listen(0, "127.0.0.1", resolve));

  const address = denServer.address();
  if (!address || typeof address === "string") throw new Error("Den fixture did not start");
  const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: `http://127.0.0.1:${address.port}`, WORKBOT_DEN_WEB_URL: "https://den.example.test", WORKBOT_RUNNER_URL: input.runnerUrl, WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) });
  const den = { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), webUrl: async () => "https://den.example.test" };
  const auth = createAuth({ config, den });
  const app = new Hono<AppEnv>();
  app.onError((error, c) => error instanceof WorkbotTurnAccessError ? error.response() : c.json({ error: "internal_error" }, 500));
  registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
    const who = denSessionSchema.parse({ user: { id: input.actor.userId, name: "Alex", email: "alex@example.test" }, organization: { id: input.actor.organizationId, name: "Recovery workspace", brandAppName: null }, memberId: input.actor.memberId, enabled: true, canSchedule: false, gatewayModels: true, model: input.managed ? paidAccessRestored ? WORKBOT_PAID_LUNA_ID : WORKBOT_FREE_LUNA_ID : "paid-model-alias" });
    c.set("member", { session: { id: "session_fixture", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "access", refreshToken: null, expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "access", den: who });
    await next();
  } });
  const send = (input: { id: string; text: string }) => app.request("http://localhost:3090/v1/workbot/messages", { method: "POST", headers: { origin: config.publicUrl, "content-type": "application/json" }, body: JSON.stringify(input) });
  return { send, restore: () => { paidAccessRestored = true; },
    async close() { denServer.closeAllConnections(); await new Promise<void>(resolve => denServer.close(() => resolve())); } };
}
