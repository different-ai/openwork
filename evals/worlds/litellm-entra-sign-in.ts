import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import type { AttachedSurface } from "@openwork/cdp";
import { liteLlm } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import { ENTRA_LOGIN_HOST, startEntraStandIn } from "@openwork/labs";
import type { EntraStandIn } from "@openwork/labs";
import { gatewayEnvironment, startAcmeGateway } from "../../worlds/lib/acme-gateway.ts";
import { isRecord, records } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

export const LITELLM_ENTRA_FEATURE = "litellmEntraMemberSignIn";
/** The name the proxy's model_list gives its one model; the admin types it into OpenWork. */
export const LITELLM_ENTRA_MODEL = "gpt-4o-mini";
export const LITELLM_ENTRA_MODEL_OUTPUT_LIMIT = 16_384;
/** What the desktop asks for when a model's catalog entry has no output limit. */
const DESKTOP_DEFAULT_MAX_OUTPUT = 32_000;
export const LITELLM_ENTRA_REPLY = "The LiteLLM proxy accepted your Microsoft sign-in.";

/** What reached LiteLLM on its client-facing address, and what it answered. Claims are read, never the token. */
export interface LiteLlmProxyCall {
  path: string;
  bearer: "none" | "key" | "token";
  issuer: string | null;
  audience: string | null;
  objectId: string | null;
  tokenId: string | null;
  status: number;
}

function claims(token: string): Record<string, unknown> | null {
  const [, payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * LiteLLM's client-facing address: forwards every request to the proxy unchanged and notes which kind of
 * credential it carried and how LiteLLM answered. This is what OpenWork is given as the proxy URL.
 */
async function startProxyIngress(stack: AsyncDisposableStack, proxyOrigin: string) {
  const calls: LiteLlmProxyCall[] = [];
  const target = new URL(proxyOrigin);
  const server = createServer((incoming, outgoing) => {
    const authorization = incoming.headers.authorization ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    const payload = presented ? claims(presented) : null;
    const forwarded = httpRequest({ host: target.hostname, port: target.port, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (answer) => {
      calls.push({
        path: (incoming.url ?? "/").split("?")[0] ?? "/", bearer: !presented ? "none" : payload ? "token" : "key",
        issuer: text(payload?.iss), audience: text(payload?.aud), objectId: text(payload?.oid), tokenId: text(payload?.uti), status: answer.statusCode ?? 502,
      });
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    });
    forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(forwarded);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  stack.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The LiteLLM ingress did not bind.");
  return { origin: `http://127.0.0.1:${address.port}`, calls: () => calls.map((call) => ({ ...call })) };
}

/**
 * The browser's requests for the Microsoft login host are answered by the stand-in, through a second CDP
 * connection on the same page (no renderer JavaScript). The address bar still reads login.microsoftonline.com.
 */
async function answerLoginHost(stack: AsyncDisposableStack, surface: AttachedSurface, entra: EntraStandIn) {
  const endpoint = surface.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("The sign-in world needs the member page's CDP endpoint.");
  const socket = new WebSocket(endpoint);
  stack.defer(() => socket.close());
  let sequence = 0;
  const send = (method: string, params: Record<string, unknown>) => socket.send(JSON.stringify({ id: ++sequence, method, params }));
  socket.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (!isRecord(message) || message.method !== "Fetch.requestPaused" || !isRecord(message.params)) return;
    const { requestId, request } = message.params;
    if (typeof requestId !== "string" || !isRecord(request) || typeof request.url !== "string" || typeof request.method !== "string") return;
    const answer = entra.respond({ method: request.method, url: request.url, body: text(request.postData) ?? "" });
    send("Fetch.fulfillRequest", {
      requestId, responseCode: answer.status,
      responseHeaders: Object.entries(answer.headers).map(([name, value]) => ({ name, value })),
      body: Buffer.from(answer.body).toString("base64"),
    });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Sign-in world: CDP connection timed out.")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Sign-in world: CDP connection failed.")); }, { once: true });
  });
  send("Fetch.enable", { patterns: [{ urlPattern: `https://${ENTRA_LOGIN_HOST}/*`, requestStage: "Request" }] });
}

/**
 * A LiteLLM proxy that takes Microsoft sign-in tokens, in front of real OpenWork:
 *
 * - LiteLLM is the real Enterprise proxy with its own JWT authentication, licensed from LITELLM_LICENSE. Its
 *   administrator created one LiteLLM user, for the member's Entra object id, and no key for anyone. It
 *   forwards to a model stand-in that answers LITELLM_ENTRA_REPLY.
 * - Den, Den web and AI Gateway are this checkout, unmodified.
 * - Entra ID is a stand-in (`startEntraStandIn`): one tenant, one app registration, two people. Den reaches it
 *   as login.microsoftonline.com through an HTTPS proxy it is told to trust; the member's browser is answered
 *   by it over CDP; LiteLLM reads its signing keys. A real tenant is never contacted.
 *
 * The feature starts off. The owner is signed in on Add a provider › LiteLLM; the member's browser is signed in
 * to OpenWork and not to Microsoft.
 */
export async function liteLlmEntraSignInWorld(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("This proof owns a loopback identity provider and a docker LiteLLM; use --local.");
  const stack = new AsyncDisposableStack();
  try {
    const entra = stack.use(await startEntraStandIn({
      accounts: {
        member: { userName: "mina@standin.example", displayName: "Mina Member" },
        teammate: { userName: "theo@standin.example", displayName: "Theo Teammate" },
      },
    }));
    const proxy = stack.use(await liteLlm({
      place, modelId: LITELLM_ENTRA_MODEL, reply: LITELLM_ENTRA_REPLY,
      // gpt-4o-mini's real limit: the model refuses a request for more output, as OpenAI does.
      maxOutputTokens: LITELLM_ENTRA_MODEL_OUTPUT_LIMIT, enforceOutputLimit: true,
      jwt: { issuer: entra.issuer, jwksUrl: entra.jwksUrl("host.docker.internal"), audience: entra.clientId },
    }));
    const proxyOrigin = new URL(proxy.baseUrl).origin;
    const proxyAdmin = async (path: string, body?: unknown) => {
      const response = await fetch(`${proxyOrigin}${path}`, {
        method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${proxy.apiKey}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
      });
      const parsed: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`LiteLLM ${path} answered HTTP ${response.status}.`);
      return parsed;
    };
    // The LiteLLM administrator's part: the member exists in LiteLLM by Entra object id, with the model and no key.
    await proxyAdmin("/user/new", { user_id: entra.accounts.member?.objectId, models: [LITELLM_ENTRA_MODEL], auto_create_key: false });
    const ingress = await startProxyIngress(stack, proxyOrigin);

    const gateway = await gatewayEnvironment(ingress.origin);
    const gatewayEnv = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({
      env: { ...gatewayEnv, ...entra.egressEnv },
      org: { name: "LiteLLM sign-in proof", admin: { name: "Gateway owner" }, members: { member: { name: "Mina Member" }, teammate: { name: "Theo Teammate" } } },
    }));
    if (!den.database) throw new Error("The LiteLLM sign-in world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env: gatewayEnv });
    const organizationId = await seededOrganizationId(seed, den.admin);
    const { member, teammate } = den.members;
    if (!member || !teammate) throw new Error("The LiteLLM sign-in world needs its two members.");

    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway/providers/new", headless: true, viewport: { width: 1440, height: 1100 } });
    const memberWeb = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 1280, height: 900 } });
    // The member already uses OpenWork in this browser: the session cookie a sign-in sets, not a Microsoft one.
    const signedIn = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, {
      method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
      body: JSON.stringify({ email: member.email, password: member.password }), signal: AbortSignal.timeout(30_000),
    });
    if (!signedIn.ok) throw new Error(`Signing the member in to OpenWork failed: HTTP ${signedIn.status}.`);
    for (const cookie of signedIn.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const separator = pair.indexOf("=");
      await memberWeb.client.send("Network.setCookie", { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: den.ref.apiUrl, httpOnly: true });
    }
    await answerLoginHost(stack, memberWeb, entra);

    const providers = async (session: Parameters<Seed["api"]>[0], scope = "") => {
      const listed = await seed.api(session, `/v1/inference-providers${scope}`);
      return isRecord(listed.body) ? records(listed.body.inferenceProviders) : [];
    };
    /** The one LiteLLM provider, as an admin reads it; null until it is added. */
    const provider = async () => (await providers(den.admin, "?scope=manageable")).find((entry) => entry.providerId === "litellm") ?? null;
    const providerId = async () => {
      const id = (await provider())?.id;
      if (typeof id !== "string") throw new Error("The LiteLLM provider has not been added yet.");
      return id;
    };
    const direct = async (bearer: string | null) => {
      const response = await fetch(`${ingress.origin}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify({ model: LITELLM_ENTRA_MODEL, messages: [{ role: "user", content: "Are you there?" }] }), signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer();
      return response.status;
    };

    return {
      den, web, memberWeb, organizationId,
      /** What the admin copies from the Entra app registration and the proxy's configuration. */
      setup: { proxyUrl: ingress.origin, tenantId: entra.tenantId, clientId: entra.clientId, clientSecret: entra.clientSecret, scope: entra.apiScope, model: LITELLM_ENTRA_MODEL },
      memberObjectId: entra.accounts.member?.objectId ?? "",
      /** The platform administrator's switch for this organization, as /admin sets it. */
      async setFeature(enabled: boolean) {
        const changed = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
          method: "PUT", body: JSON.stringify({ capabilities: { [LITELLM_ENTRA_FEATURE]: enabled } }),
        });
        if (!changed.response.ok) throw new Error(`Setting ${LITELLM_ENTRA_FEATURE} failed: HTTP ${changed.response.status}.`);
      },
      /** What the API answers an admin who asks for this mode directly. */
      async addProviderThroughApi() {
        const answered = await seed.api(den.admin, "/v1/inference-providers/litellm", {
          method: "POST", body: JSON.stringify({ name: "LiteLLM", baseUrl: ingress.origin, mode: "entra", oauthTenantId: entra.tenantId, oauthClientId: entra.clientId,
            oauthClientSecret: entra.clientSecret, oauthScope: entra.apiScope, modelIds: [LITELLM_ENTRA_MODEL], allMembers: true }),
        });
        return { status: answered.response.status, error: isRecord(answered.body) ? text(answered.body.error) : null };
      },
      provider,
      /** The admin adds the provider's redirect URI to the app registration, as its page tells them to. */
      addRedirectUri: (uri: string) => entra.addRedirectUri(uri),
      /** What OpenWork answers when this person selects Connect on one of the provider's models: the page to open, or a refusal. */
      async startConnect(person: "member" | "teammate" = "member") {
        const session = person === "member" ? member : teammate;
        const id = await providerId();
        const usable = (await providers(session)).find((entry) => entry.id === id);
        // OpenWork hands the app this address while the person still has to connect; afterwards the app keeps using it.
        const credentialSet = text(records((await provider())?.credentialSets)[0]?.id);
        const requested = text(records(usable?.authorizationRequests)[0]?.authUrl)
          ?? (credentialSet ? `/v1/inference-providers/${id}/oauth/start?credentialSetId=${encodeURIComponent(credentialSet)}` : null);
        if (!requested) throw new Error("OpenWork has no Connect address for this provider.");
        const start = new URL(requested, den.ref.apiUrl);
        const started = await seed.api(session, `${start.pathname}${start.search}`, { headers: { accept: "application/json" } });
        const body = isRecord(started.body) ? started.body : {};
        return { status: started.response.status, error: text(body.error), link: started.response.ok ? text(body.authUrl) : null };
      },
      /** What OpenWork tells this person about the provider: whether they must connect, and their models. */
      async access(person: "member" | "teammate" = "member") {
        const id = await providerId();
        const usable = (await providers(person === "member" ? member : teammate)).find((entry) => entry.id === id);
        return { credentialStatus: text(usable?.credentialStatus), models: records(usable?.models).length };
      },
      /** One chat request through AI Gateway with this person's own OpenWork key, as their app sends it. */
      async chat(person: "member" | "teammate" = "member") {
        const id = await providerId();
        const connected = await seed.api(person === "member" ? member : teammate, `/v1/inference-providers/${id}/connect`);
        const connection = isRecord(connected.body) && isRecord(connected.body.inferenceProvider) ? connected.body.inferenceProvider : null;
        const apiKey = text(connection?.apiKey);
        const listed = records(connection?.models)[0];
        const model = text(listed?.id) ?? LITELLM_ENTRA_MODEL;
        // As the app does: it asks for the model's output limit from the list OpenWork gave it.
        const limit = isRecord(listed?.config) && isRecord(listed.config.limit) ? listed.config.limit : {};
        const maxTokens = typeof limit.output === "number" ? limit.output : DESKTOP_DEFAULT_MAX_OUTPUT;
        if (!apiKey) return { status: connected.response.status, reply: null, error: isRecord(connected.body) ? text(connected.body.error) : null, sentTo: "den" as const };
        const response = await fetch(`${gateway.baseUrl}/api/v1/providers/${id}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: "Are you there?" }] }), signal: AbortSignal.timeout(60_000),
        });
        const body: unknown = await response.json().catch(() => null);
        const choice = isRecord(body) ? records(body.choices)[0] : undefined;
        const error = isRecord(body) && isRecord(body.error) ? text(body.error.code) ?? text(body.error.type) ?? text(body.error.message) : isRecord(body) ? text(body.error) : null;
        return { status: response.status, reply: isRecord(choice?.message) ? text(choice.message.content) : null, error, maxTokens, sentTo: "gateway" as const };
      },
      /** Every request that reached LiteLLM's address, with the kind of credential and LiteLLM's answer. */
      proxyCalls: ingress.calls,
      /** Requests the model behind LiteLLM received: proof a request got through the proxy. */
      modelRequests: () => proxy.upstreamRequests({ after: 0 }),
      /** LiteLLM's own record of the member: their user, and how many LiteLLM keys they hold. */
      async proxyUser() {
        const info = await proxyAdmin(`/user/info?user_id=${encodeURIComponent(entra.accounts.member?.objectId ?? "")}`);
        const user = isRecord(info) && isRecord(info.user_info) ? info.user_info : null;
        return { userId: text(user?.user_id), keys: isRecord(info) ? records(info.keys).length : -1 };
      },
      /** LiteLLM asked directly, without OpenWork: what it answers to each kind of credential. */
      async proxyAnswers() {
        return {
          noCredential: await direct(null),
          madeUpKey: await direct(`sk-${randomUUID().replaceAll("-", "")}`),
          tokenFromAnotherSigner: await direct(entra.mintAccessToken("member", { foreignKey: true })),
          tokenForAnotherAudience: await direct(entra.mintAccessToken("member", { audience: randomUUID() })),
          tokenFromAnotherTenant: await direct(entra.mintAccessToken("member", { issuer: `https://${ENTRA_LOGIN_HOST}/${randomUUID()}/v2.0` })),
          expiredToken: await direct(entra.mintAccessToken("member", { expiresInSeconds: -60 })),
          personUnknownToLiteLlm: await direct(entra.mintAccessToken("teammate")),
        };
      },
      /** What the stand-in was asked for and issued, by account and token id (never a token). */
      signIns: () => ({ tokenRequests: entra.tokenRequests(), issued: entra.issuedTokens() }),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
