import { allocateFreePorts } from "@openwork/cdp";
import { managedInference, type Place, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { signedInAppWeb } from "./signed-in-app-web.ts";

/** An OpenWork Models alias the gateway serves (packages/types INFERENCE_MODEL_ALIASES). */
const MODEL = "z-ai/glm-5.2";
const MODEL_NAME = "GLM-5.2";

/**
 * Acme pays for OpenWork Models and has used this 5-hour window's allowance. The real gateway (its own
 * disposable database, a fake OpenRouter upstream) answers the app's real engine; Den decides who is an admin. An owner and a member each have the app open, both on OpenWork Models.
 */
export async function usageLimitUpgradeDesktop(seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  try {
    const gateway = resources.use(await managedInference(place));
    await gateway.exhaustAllowance("five_hour", 70 * 60_000);
    const [adminPort, memberPort] = await allocateFreePorts(2);
    if (!adminPort || !memberPort) throw new Error("No ports for the two app windows.");
    const den = await seed.den({
      trustedOrigins: [`http://127.0.0.1:${adminPort}`, `http://127.0.0.1:${memberPort}`],
      org: { name: "Acme", admin: { name: "Riley Owner" }, members: { member: { name: "Jordan Member" } } },
    });
    const openWorkModels = (workspaceId: string, app: Parameters<typeof configureProvider>[1]) => configureProvider(seed, app, workspaceId, "openwork", MODEL, {
      provider: { openwork: {
        npm: "@ai-sdk/openai-compatible", name: "OpenWork Models",
        options: { baseURL: `${gateway.url}/api/v1`, apiKey: gateway.identity.key },
        models: { [MODEL]: { name: MODEL_NAME } },
      } },
    });
    const owner = await signedInAppWeb(seed, { den, webPort: adminPort, as: "admin", name: "usage-limit-owner", headless: true,
      workspacePath: seed.tmpPath("usage-limit-owner") });
    await openWorkModels(owner.workspace.workspaceId, owner.app);
    const ownerSession = await seed.session(owner.app, { title: "Hiring plan" });
    const member = await signedInAppWeb(seed, { den, webPort: memberPort, as: "member", name: "usage-limit-member", headless: true,
      workspacePath: seed.tmpPath("usage-limit-member") });
    await openWorkModels(member.workspace.workspaceId, member.app);
    const memberSession = await seed.session(member.app, { title: "Contract summary" });
    const stack = resources.move();
    return {
      app: owner.app, memberApp: member.app, den, ownerSession, memberSession, modelName: MODEL_NAME,
      /** Requests that reached the gateway for Acme, refused or not. */
      gatewayRequests: () => gateway.requestCount(),
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
