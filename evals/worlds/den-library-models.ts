import { createHmac, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { allocateFreePort, connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Place, type Seed } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}
function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Expected ${label}`);
  return value;
}

const GOOGLE_ACCOUNT = "sam@example.com";
const OAUTH_CLIENT_ID = "fixture-client.apps.googleusercontent.com";

/**
 * A stand-in for Google's token, revocation and signing-key endpoints. Den's
 * real OAuth handlers run unchanged; only these three fixed Google URLs are
 * answered here, through a test-only preload in the isolated Den child (the
 * same seam inference-gateway-lifecycle uses). It signs a real RS256 ID token
 * for the fixture account, so Den's identity verification runs for real.
 */
async function googleStandIn() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const exchanges: { clientId: string }[] = [];
  let revocations = 0;
  const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");
  function idToken(clientId: string, nonce: string) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = base64url(JSON.stringify({
      iss: "https://accounts.google.com", aud: clientId, azp: clientId, sub: "fixture-google-subject-sam",
      email: GOOGLE_ACCOUNT, email_verified: true, nonce, iat: now, exp: now + 3600,
    }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
  }
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (req.url === "/certs") { res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === "/revoke") { revocations += 1; res.end("{}"); return; }
    if (req.url === "/token") {
      // The browser stand-in encodes Den's OAuth state in the code, so the
      // ID token can carry the nonce Den derives from the PKCE verifier.
      const code = body.get("code") ?? "";
      const clientId = body.get("client_id") ?? "";
      const verifier = body.get("code_verifier") ?? "";
      const state = code.startsWith("approved.") ? code.slice("approved.".length) : "";
      if (!state || !verifier) { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" })); return; }
      exchanges.push({ clientId });
      const nonce = createHmac("sha256", verifier).update(`gateway-google-oidc-v1:${state}`).digest("base64url");
      res.end(JSON.stringify({
        access_token: `fixture-access-${randomUUID()}`, refresh_token: `fixture-refresh-${randomUUID()}`, token_type: "Bearer",
        expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/cloud-platform", id_token: idToken(clientId, nonce),
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("The Google stand-in did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  const preload = `
const originalFetch = globalThis.fetch;
const standIn = ${JSON.stringify(url)};
const routes = { "https://oauth2.googleapis.com/token": "/token", "https://oauth2.googleapis.com/revoke": "/revoke", "https://www.googleapis.com/oauth2/v3/certs": "/certs" };
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const route = routes[url];
  if (!route) return originalFetch(input, init);
  return originalFetch(standIn + route, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body, signal: init?.signal });
};`;
  return {
    preload,
    exchanges: () => [...exchanges],
    revocations: () => revocations,
    async stop() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/**
 * Stands in for Google's sign-in page inside the tab Den opens. It never
 * loads accounts.google.com: it reads the request Den sent and answers the
 * way Google would, with Den's own callback address.
 */
async function answerGoogleSignIn(tab: { webSocketDebuggerUrl: string }, decision: "approve" | "deny") {
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<number, (value: unknown) => void>();
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve) => {
    nextId += 1;
    pending.set(nextId, resolve);
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
  const seen: { clientId: string | null; prompt: string | null }[] = [];
  socket.addEventListener("message", (event) => {
    const message = record(JSON.parse(String(event.data)));
    if (typeof message.id === "number") { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
    if (message.method !== "Fetch.requestPaused") return;
    const params = record(message.params);
    const request = new URL(text(record(params.request).url, "request url"));
    const redirect = new URL(text(request.searchParams.get("redirect_uri"), "redirect_uri"));
    const state = text(request.searchParams.get("state"), "state");
    seen.push({ clientId: request.searchParams.get("client_id"), prompt: request.searchParams.get("prompt") });
    redirect.searchParams.set("state", state);
    if (decision === "approve") redirect.searchParams.set("code", `approved.${state}`);
    else redirect.searchParams.set("error", "access_denied");
    void send("Fetch.fulfillRequest", {
      requestId: params.requestId, responseCode: 302,
      responseHeaders: [{ name: "Location", value: redirect.toString() }, { name: "Cache-Control", value: "no-store" }],
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not attach to the sign-in tab")), { once: true });
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://accounts.google.com/*", requestStage: "Request" }] });
  return { seen: () => [...seen], close: () => socket.close() };
}

/**
 * Acme Studio's AI Gateway gives Sam and Maya three model providers:
 * Anthropic, signed in once by the organization; Google Cloud, where each
 * person signs in with their own Google account; and Mistral, which the
 * admin has not finished setting up. Den, den-web and the Gateway's OAuth
 * handlers are real; no request reaches Google or a model provider.
 */
export async function denLibraryModels(seed: Seed, { place }: { place: Place }, options: { asAdmin?: boolean } = {}) {
  if (place.kind !== "local") throw new Error("This world preloads a Google stand-in into the Den child; run it on the local lane.");
  const google = await googleStandIn();
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const den = await seed.den({
    web: true,
    env: {
      DEN_ORG_MODE: "multi_org", GATEWAY_ENABLED: "true",
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(google.preload)}`,
    },
    org: {
      name: "Acme Studio",
      admin: { name: "Riley Admin", email: "riley@example.com" },
      members: { sam: { name: "Sam K.", email: "sam.k@example.com" }, maya: { name: "Maya Chen", email: "maya@example.com" } },
    },
  });
  const sam = den.members.sam;
  const maya = den.members.maya;
  if (!sam || !maya) throw new Error("Expected Sam and Maya");
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const members = list(org.members);
  const memberId = (email: string) => text(members.find((entry) => record(entry.user).email === email)?.id, `${email}'s membership`);
  const memberIds = [memberId(sam.email), memberId(maya.email)];

  async function catalogModels(providerId: string, pattern: RegExp, count: number): Promise<string[]> {
    const result = await seed.api(den.admin, `/v1/llm-provider-catalog/${providerId}`);
    const provider = record(record(result.body).provider);
    const ids = list(provider.models).map((entry) => String(entry.id)).filter((id) => pattern.test(id) && !/preview|exp|lite|image|tts|live|embed/i.test(id));
    if (ids.length < count) throw new Error(`The ${providerId} catalog has fewer than ${count} models matching ${pattern}: ${ids.join(", ")}`);
    return ids.slice(0, count);
  }
  async function createProvider(input: Record<string, unknown>) {
    const result = await seed.api(den.admin, "/v1/inference-providers", { method: "POST", body: JSON.stringify(input) });
    if (result.response.status !== 201) throw new Error(`Could not add ${String(input.name)}: HTTP ${result.response.status} ${result.text.slice(0, 400)}`);
    return text(record(record(result.body).inferenceProvider).id, "provider id");
  }

  const googleCloudId = await createProvider({
    name: "Google Cloud", providerId: "google-vertex", modelIds: await catalogModels("google-vertex", /^gemini-2\.5/, 2), memberIds,
    credentialMode: "member", settings: { project: "acme-studio-fixture", location: "us-central1" },
    oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: "fixture-client-secret",
  });
  await createProvider({
    name: "Anthropic", providerId: "anthropic", modelIds: await catalogModels("anthropic", /^claude-(sonnet|opus)-4/, 2), memberIds,
    credential: { kind: "api_key", secret: "fixture-upstream-key" },
  });
  // Mistral: the organization's shared key stopped working, so only the admin
  // can bring it back. Den has no API to put a credential in that state, so the
  // world marks it the way Den's refresh job would.
  const mistralId = await createProvider({
    name: "Mistral", providerId: "mistral", modelIds: await catalogModels("mistral", /^(mistral-large|codestral)/, 1), memberIds,
    credential: { kind: "api_key", secret: "fixture-upstream-key" },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("This world needs the testkit-owned scratch database.");
  await queryDenDatabase(databaseUrl, "UPDATE gateway_provider_credentials SET status = 'refresh_failed' WHERE gateway_provider_id = ?", [mistralId]);

  const viewport = { width: 1440, height: 900 };
  const web = options.asAdmin
    ? await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=ai-providers", headless: true, viewport })
    : await seed.web({ den, signedInAs: sam, startPath: "/dashboard/library?show=models", headless: true, viewport });
  const webOrigin = new URL(den.ref.webUrl).origin;
  // Sam signed in to Den in this browser with his password, the way people
  // do, so the browser also holds his Den session cookie. OpenWork's sign-in
  // tab checks that cookie before it sends anyone to Google.
  if (!options.asAdmin) {
    const signedIn = await seed.api(sam, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: sam.email, password: sam.password }) });
    const sessionCookie = signedIn.response.headers.getSetCookie().find((value) => value.includes("session_token="))?.split(";")[0] ?? "";
    const separator = sessionCookie.indexOf("=");
    if (!signedIn.response.ok || separator < 1) throw new Error(`Could not sign Sam in with his password: HTTP ${signedIn.response.status}`);
    const applied = record(await web.client.send("Network.setCookie", {
      name: sessionCookie.slice(0, separator), value: sessionCookie.slice(separator + 1), url: den.ref.webUrl, path: "/", httpOnly: true,
    }));
    if (applied.success !== true) throw new Error("Could not give the browser Sam's Den session cookie.");
  }

  async function memberConnections(session: DenSession) {
    const result = await seed.api(session, "/v1/inference-providers/member-connections");
    return list(record(result.body).connections).filter((entry) => entry.providerId === googleCloudId);
  }
  async function usableModelNames(session: DenSession) {
    const result = await seed.api(session, "/v1/inference-providers?scope=usable");
    const provider = list(record(result.body).inferenceProviders).find((entry) => entry.id === googleCloudId);
    return list(provider?.models).map((entry) => String(entry.name));
  }

  return Object.assign({
    den, web, sam, maya, googleCloudId, googleAccount: GOOGLE_ACCOUNT, oauthClientId: OAUTH_CLIENT_ID,
    /** Google Cloud models Den will actually serve this person right now. */
    usableModelNames,
    /** The organization's default for new chats, as Den resolves it for this person. */
    async defaultModelFor(session: DenSession) {
      const result = await seed.api(session, "/v1/org/default-model");
      return record(result.body);
    },
    /** This person's own Google sign-in for Google Cloud, straight from Den. */
    memberConnections,
    googleTokenExchanges: google.exchanges,
    googleRevocations: google.revocations,
    /** The tab Den opened for Google sign-in, once it reaches OpenWork's sign-in page. */
    async signInTab({ timeoutMs = 30_000 } = {}): Promise<Surface & { webSocketDebuggerUrl: string }> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const target = (await listTargets(web.handle.cdpUrl)).find((entry) => entry.type === "page" && entry.id !== web.client.targetId && entry.url.startsWith(`${webOrigin}/gateway/connect`));
        if (target) {
          const webSocketDebuggerUrl = debuggerUrlFor(web.handle.cdpUrl, target);
          return { handle: web.handle, client: await connect(webSocketDebuggerUrl), webSocketDebuggerUrl };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Den did not open a sign-in tab.");
    },
    /** Google's side of sign-in: approve or deny whatever Den asks for in that tab. */
    googleAnswers: answerGoogleSignIn,
    async closeTab(tab: Surface) {
      if (tab.client.targetId) await web.client.send("Target.closeTarget", { targetId: tab.client.targetId });
      tab.client.close();
    },
    async location(): Promise<string> {
      const targets = await listTargets(web.handle.cdpUrl);
      const url = targets.find((entry) => entry.id === web.client.targetId)?.url ?? "";
      const parsed = new URL(url);
      return parsed.pathname + parsed.search;
    },
  }, {
    async [Symbol.asyncDispose]() {
      await google.stop();
    },
  });
}

/** The same organization, with the admin on Manage › AI Gateway › AI Providers. */
export const denLibraryModelsAsAdmin = (seed: Seed, ctx: { place: Place }) => denLibraryModels(seed, ctx, { asAdmin: true });
