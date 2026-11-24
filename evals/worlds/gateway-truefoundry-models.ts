import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Seed } from "@openwork/env";
import { gatewayEnvironment, startAcmeGateway } from "../../worlds/lib/acme-gateway.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { isRecord } from "./library.ts";

/** Chat models the fake tenant serves, as TrueFoundry lists them: `<provider account>/<model>`. */
export const TRUEFOUNDRY_CHAT_MODELS = ["anthropic-main/claude-sonnet-4-5", "openai-main/gpt-4o", "openai-main/gpt-4o-mini", "openai-main/gpt-5.5"] as const;
/** Listed too, but not a chat model, so OpenWork never offers it. */
export const TRUEFOUNDRY_EMBEDDING_MODEL = "openai-main/text-embedding-3-small";

/** Personal access tokens each TrueFoundry user may hold, as tenants commonly set it. */
export const TRUEFOUNDRY_TOKENS_PER_USER = 3;

/**
 * A TrueFoundry tenant that follows the rules OpenWork relies on: one
 * tenant-admin virtual account key, every OpenWork email is already a
 * TrueFoundry user, the admin creates personal access tokens for people (at
 * most TRUEFOUNDRY_TOKENS_PER_USER each) or revokes all of one person's, a
 * token lists and deletes itself, and every key reaches every chat model.
 */
async function startTrueFoundryTenant(stack: AsyncDisposableStack) {
  const adminKey = `tfy_va_${randomUUID().replaceAll("-", "")}`;
  const tokens = new Map<string, { id: string; name: string; email: string; createdAt: string }>();
  /** expirationDate of every token the admin created, in order. */
  const expirations: Array<string | null> = [];
  /** /models answers 503 to people's tokens this many more times (a TrueFoundry outage). */
  let modelsOutages = 0;
  const tokensOf = (email: string) => [...tokens.values()].filter((token) => token.email === email).length;
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
        if (token && modelsOutages > 0) { modelsOutages -= 1; return json(503, { message: "Service unavailable" }); }
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
        if (tokensOf(email) >= TRUEFOUNDRY_TOKENS_PER_USER) return json(400, { message: `User has reached the maximum number of personal access tokens (${TRUEFOUNDRY_TOKENS_PER_USER}).` });
        expirations.push(isRecord(body) && typeof body.expirationDate === "string" ? body.expirationDate : null);
        const value = `tfy_pat_${randomUUID().replaceAll("-", "")}`;
        tokens.set(value, { id: randomUUID(), name, email, createdAt: new Date().toISOString() });
        return json(200, { token: value });
      }
      if (url.pathname === "/api/svc/v1/personal-access-tokens/revoke/all" && request.method === "DELETE") {
        if (!admin) return json(403, { message: "Forbidden" });
        const email = isRecord(body) && typeof body.email === "string" ? body.email : "";
        for (const [value, entry] of tokens) if (entry.email === email) tokens.delete(value);
        return json(200, {});
      }
      if (url.pathname === "/api/svc/v1/personal-access-tokens" && request.method === "GET") {
        // The caller's own tokens only: an admin key lists none of the people's.
        const query = url.searchParams.get("nameSearchQuery") ?? "";
        const own = token ? [...tokens.values()].filter((entry) => entry.email === token.email && entry.name.includes(query)) : [];
        return json(200, { data: own.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, manifest: { name: entry.name } })) });
      }
      if (url.pathname.startsWith("/api/svc/v1/personal-access-tokens/") && request.method === "DELETE") {
        // A user's token deletes any token of the same user; nobody else's.
        const id = decodeURIComponent(url.pathname.slice("/api/svc/v1/personal-access-tokens/".length));
        const target = [...tokens.entries()].find(([, entry]) => entry.id === id);
        if (!token || !target) return json(404, { message: "Not found" });
        if (target[1].email !== token.email) return json(403, { message: "Forbidden" });
        tokens.delete(target[0]);
        return json(200, {});
      }
      return json(404, { message: "Not found" });
    } catch (error) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ message: `Fake tenant: ${error instanceof Error ? error.message : String(error)}` })); }
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
  return {
    url: `http://127.0.0.1:${address.port}`,
    adminKey,
    tokenCount: () => tokens.size,
    tokensOf,
    expirations: () => [...expirations],
    failModels(times: number) { modelsOutages = times; },
    /**
     * The person's OpenWork key expires, and they already hold as many tokens as TrueFoundry
     * allows (their own, or keys an older OpenWork lost track of): their next key is refused.
     */
    fillTokens(email: string) {
      for (const [value, entry] of tokens) if (entry.email === email) tokens.delete(value);
      for (let index = 0; index < TRUEFOUNDRY_TOKENS_PER_USER; index += 1) tokens.set(`tfy_pat_own_${randomUUID()}`, { id: randomUUID(), name: `laptop-${index}`, email, createdAt: new Date().toISOString() });
    },
    /** Names of the person's tokens. */
    tokenNamesOf: (email: string) => [...tokens.values()].filter((entry) => entry.email === email).map((entry) => entry.name).sort(),
    /** A token the person holds from a day ago, e.g. one an older OpenWork created and lost, or their own. */
    addOldToken(email: string, name: string) {
      tokens.set(`tfy_pat_old_${randomUUID()}`, { id: randomUUID(), name, email, createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    },
  };
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
      member,
      /** The provider as its owner reads it. */
      provider: () => seed.api(den.admin, `/v1/inference-providers/${providerId}`),
      /** TrueFoundry model ids the member's OpenWork is given for this provider (members see Gateway aliases; upstreamModelId is TrueFoundry's id). */
      async memberModels(): Promise<string[]> {
        const connected = await seed.api(member, `/v1/inference-providers/${providerId}/connect`);
        const body = isRecord(connected.body) && isRecord(connected.body.inferenceProvider) ? connected.body.inferenceProvider : null;
        const models = Array.isArray(body?.models) ? body.models.filter(isRecord) : [];
        return [...new Set(models.map((model) => String(model.upstreamModelId)))].sort();
      },
      /** The model config the member's OpenWork is given for one TrueFoundry model (reasoning efforts, prices). */
      async memberModelConfig(upstreamModelId: string): Promise<Record<string, unknown> | null> {
        const connected = await seed.api(member, `/v1/inference-providers/${providerId}/connect`);
        const body = isRecord(connected.body) && isRecord(connected.body.inferenceProvider) ? connected.body.inferenceProvider : null;
        const models = Array.isArray(body?.models) ? body.models.filter(isRecord) : [];
        const model = models.find((entry) => entry.upstreamModelId === upstreamModelId);
        return model && isRecord(model.config) ? model.config : null;
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

