import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Seed } from "@openwork/env";
import { gatewayEnvironment, startAcmeGateway } from "../../worlds/lib/acme-gateway.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { isRecord } from "./library.ts";

/** Chat models the fake tenant serves, as TrueFoundry lists them: `<provider account>/<model>`. */
export const TRUEFOUNDRY_CHAT_MODELS = ["anthropic-main/claude-sonnet-4-5", "openai-main/gpt-4o", "openai-main/gpt-4o-mini"] as const;
/** Listed too, but not a chat model, so OpenWork never offers it. */
export const TRUEFOUNDRY_EMBEDDING_MODEL = "openai-main/text-embedding-3-small";

/**
 * A TrueFoundry tenant that follows the rules OpenWork relies on: one
 * tenant-admin virtual account key, every OpenWork email is already a
 * TrueFoundry user, the admin creates one personal access token per person,
 * a token lists and deletes itself, and every key reaches every chat model.
 */
async function startTrueFoundryTenant(stack: AsyncDisposableStack) {
  const adminKey = `tfy_va_${randomUUID().replaceAll("-", "")}`;
  const tokens = new Map<string, { id: string; name: string; email: string }>();
  const tenant = createServer(async (request, response) => {
    const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    try {
      const url = new URL(request.url ?? "/", "http://tenant");
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const token = tokens.get(bearer);
      const admin = bearer === adminKey;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      if (!admin && !token) return json(401, { message: "Unauthorized" });

      if (url.pathname === "/api/llm/models" && request.method === "GET") {
        return json(200, { data: [
          ...TRUEFOUNDRY_CHAT_MODELS.map((id) => ({ id, object: "model", model_types: ["chat"] })),
          { id: TRUEFOUNDRY_EMBEDDING_MODEL, object: "model", model_types: ["embedding"] },
        ] });
      }
      if (url.pathname === "/api/llm/chat/completions" && request.method === "POST") {
        if (!token) return json(403, { message: "Use a personal access token." });
        const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
        if (!TRUEFOUNDRY_CHAT_MODELS.some((id) => id === model)) return json(404, { message: `Unknown model ${model}` });
        return json(200, { id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: 1, model,
          choices: [{ index: 0, message: { role: "assistant", content: `TrueFoundry ${model} answered.` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      }
      if (url.pathname === "/api/svc/v1/users/register" && request.method === "POST") {
        return admin ? json(200, { ok: true }) : json(403, { message: "Forbidden" });
      }
      if (url.pathname === "/api/svc/v1/users" && request.method === "GET") {
        if (!admin) return json(403, { message: "Forbidden" });
        const email = url.searchParams.get("query") ?? "";
        return json(200, { data: email ? [{ id: `user-${email}`, email, active: true }] : [] });
      }
      if (url.pathname === "/api/svc/v1/personal-access-tokens/for-user" && request.method === "POST") {
        if (!admin) return json(400, { message: "A personal access token can't create tokens for other users." });
        const name = isRecord(body) && typeof body.name === "string" ? body.name : "";
        const email = isRecord(body) && typeof body.userEmail === "string" ? body.userEmail : "";
        const value = `tfy_pat_${randomUUID().replaceAll("-", "")}`;
        tokens.set(value, { id: randomUUID(), name, email });
        return json(200, { token: value });
      }
      if (url.pathname === "/api/svc/v1/personal-access-tokens" && request.method === "GET") {
        return json(200, { data: token ? [{ id: token.id, manifest: { name: token.name } }] : [] });
      }
      if (url.pathname.startsWith("/api/svc/v1/personal-access-tokens/") && request.method === "DELETE") {
        if (token) tokens.delete(bearer);
        return json(200, {});
      }
      return json(404, { message: "Not found" });
    } catch { response.writeHead(400).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    tenant.once("error", reject);
    tenant.listen(0, "127.0.0.1", resolve);
  });
  stack.defer(async () => {
    tenant.closeAllConnections();
    await new Promise<void>((resolve, reject) => tenant.close((error) => error ? reject(error) : resolve()));
  });
  const address = tenant.address();
  if (!address || typeof address === "string") throw new Error("The TrueFoundry tenant did not bind.");
  return { url: `http://127.0.0.1:${address.port}`, adminKey, tokenCount: () => tokens.size };
}

/**
 * A TrueFoundry provider on AI Gateway: a real Den and AI Gateway, a fake
 * TrueFoundry tenant the operator allowlisted, and a TrueFoundry provider
 * already connected for everyone. The owner is signed in on that provider's
 * page.
 */
export async function gatewayTrueFoundryModelsWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const tenant = await startTrueFoundryTenant(stack);
    const gateway = await gatewayEnvironment(tenant.url);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "TrueFoundry models proof", admin: { name: "Gateway owner" }, members: { member: { name: "Gateway member" } } } }));
    if (!den.database) throw new Error("The TrueFoundry world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const organizationId = await seededOrganizationId(seed, den.admin);
    const member = den.members.member;
    if (!member) throw new Error("The TrueFoundry world needs its member.");

    const created = await seed.api(den.admin, "/v1/inference-providers/truefoundry", {
      method: "POST",
      body: JSON.stringify({ name: "TrueFoundry", controlPlaneUrl: tenant.url, apiKey: tenant.adminKey, allMembers: true }),
    });
    const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
    if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Connecting TrueFoundry failed: ${created.response.status} ${created.text.slice(0, 400)}`);
    const providerId = provider.id;

    const web = await seed.web({ den, signedInAs: den.admin, startPath: `/dashboard/ai-gateway/providers/${providerId}`, headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      organizationId,
      providerId,
      tenant,
      /** The provider as its owner reads it. */
      provider: () => seed.api(den.admin, `/v1/inference-providers/${providerId}`),
      /** TrueFoundry model ids the member's OpenWork is given for this provider (members see Gateway aliases; upstreamModelId is TrueFoundry's id). */
      async memberModels(): Promise<string[]> {
        const connected = await seed.api(member, `/v1/inference-providers/${providerId}/connect`);
        const body = isRecord(connected.body) && isRecord(connected.body.inferenceProvider) ? connected.body.inferenceProvider : null;
        const models = Array.isArray(body?.models) ? body.models.filter(isRecord) : [];
        return [...new Set(models.map((model) => String(model.upstreamModelId)))].sort();
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

