import { createServer } from "node:http";
import { allocateFreePort, browserScript, debuggerUrlFor, listTargets, reload } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { DenSession } from "@openwork/behaviors";
import type { Place, Seed } from "@openwork/env";
import { answerGoogleSignIn, GOOGLE_ACCOUNT, googleStandIn, OAUTH_CLIENT_ID } from "./den-library-models.ts";
import { desktopWithExternalOpenCapture } from "./library.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Expected ${label}`);
  return value;
}

const ANSWER = "Here is the launch plan in three lines.";

/**
 * Stands in for the OpenWork Gateway, where the desktop sends model requests.
 * Google Cloud answers exactly as the Gateway does when Google has signed the
 * person out: 401 openwork_auth_required with the provider and credential
 * set. Anthropic streams a short answer in Anthropic's own format. No request
 * reaches a model provider.
 */
async function gatewayStandIn() {
  const requests: { provider: string; prompt: string }[] = [];
  let signedOut: { providerId: string; credentialSetId: string } | null = null;
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const provider = /\/providers\/([^/]+)/.exec(req.url ?? "")?.[1] ?? "";
    requests.push({ provider, prompt: body.includes("Summarize the launch plan") ? "Summarize the launch plan" : "" });
    if (signedOut && provider === signedOut.providerId) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-openwork-auth-required", "1");
      res.end(JSON.stringify({ error: {
        message: "Connect your google-vertex account in OpenWork to use this provider (credential revoked).",
        type: "invalid_request_error", code: "openwork_auth_required",
        provider_id: signedOut.providerId, credential_set_id: signedOut.credentialSetId,
      } }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    const event = (name: string, data: Record<string, unknown>) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
    event("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: ANSWER } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
    event("message_stop", {});
    res.end();
  });
  const port = await allocateFreePort();
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => [...requests],
    signOut: (providerId: string, credentialSetId: string) => { signedOut = { providerId, credentialSetId }; },
    async stop() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

type Options = {
  /** Sam already signed in to Google Cloud (and the conversation uses Gemini). */
  signedIn?: boolean;
  /** Acme Studio picked Gemini 2.5 Pro as Sam's default model. */
  defaultToGemini?: boolean;
};

/**
 * Acme Studio gives Sam two model providers through the AI Gateway: Anthropic,
 * signed in once by the company, and Google Cloud, where each person signs in
 * with their own Google account. Sam uses the OpenWork desktop app; a browser
 * where Sam is signed in to OpenWork finishes Google sign-in. Den, the desktop
 * and its OpenCode engine are real; Google and the Gateway are stand-ins.
 */
export async function modelsSignIn(seed: Seed, { place }: { place: Place }, options: Options = {}) {
  if (place.kind !== "local") throw new Error("This world preloads a Google stand-in into the Den child; run it on the local lane.");
  const google = await googleStandIn();
  const gateway = await gatewayStandIn();
  const den = await seed.den({
    web: true,
    env: {
      DEN_ORG_MODE: "multi_org", GATEWAY_ENABLED: "true",
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql",
      GATEWAY_PROXY_BASE_URL: gateway.url, GATEWAY_PUBLIC_BASE_URL: gateway.url,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(google.preload)}`,
    },
    org: {
      name: "Acme Studio",
      admin: { name: "Riley Admin", email: "riley@example.com" },
      members: { sam: { name: "Sam K.", email: "sam.k@example.com" } },
    },
  });
  const sam = den.members.sam;
  if (!sam) throw new Error("Expected Sam");
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const samId = text(list(org.members).find((entry) => record(entry.user).email === sam.email)?.id, "Sam's membership");

  async function catalogModels(providerId: string, pattern: RegExp, count: number) {
    const result = await seed.api(den.admin, `/v1/llm-provider-catalog/${providerId}`);
    const ids = list(record(record(result.body).provider).models).map((entry) => String(entry.id))
      .filter((id) => pattern.test(id) && !/preview|exp|lite|image|tts|live|embed|latest/i.test(id));
    if (ids.length < count) throw new Error(`The ${providerId} catalog lacks ${count} models matching ${pattern}: ${ids.join(", ")}`);
    return ids.slice(0, count);
  }
  async function createProvider(input: Record<string, unknown>) {
    const result = await seed.api(den.admin, "/v1/inference-providers", { method: "POST", body: JSON.stringify(input) });
    if (result.response.status !== 201) throw new Error(`Could not add ${String(input.name)}: HTTP ${result.response.status} ${result.text.slice(0, 400)}`);
    return text(record(record(result.body).inferenceProvider).id, "provider id");
  }
  const anthropicId = await createProvider({
    name: "Anthropic", providerId: "anthropic", modelIds: await catalogModels("anthropic", /^claude-sonnet-4/, 1), memberIds: [samId],
    credential: { kind: "api_key", secret: "fixture-upstream-key" },
  });
  const googleCloudId = await createProvider({
    name: "Google Cloud", providerId: "google-vertex", modelIds: await catalogModels("google-vertex", /^gemini-2\.5-(pro|flash)$/, 2), memberIds: [samId],
    credentialMode: "member", settings: { project: "acme-studio-fixture", location: "us-central1" },
    oauthClientId: OAUTH_CLIENT_ID, oauthClientSecret: "fixture-client-secret",
  });
  const usable = list(record((await seed.api(sam, "/v1/inference-providers?scope=usable")).body).inferenceProviders);
  const googleSummary = usable.find((entry) => entry.id === googleCloudId);
  const request = list(googleSummary?.authorizationRequests)[0];
  const credentialSetId = text(request?.credentialSetId, "Google Cloud credential set");
  const geminiPro = list(request?.models).find((model) => String(model.upstreamModelId).includes("pro"));
  const geminiProId = text(geminiPro?.id, "Gemini 2.5 Pro alias");
  const geminiProName = text(geminiPro?.name, "Gemini 2.5 Pro name");

  // Sam signs in to Den in the browser with a password, as people do.
  const signedIn = await seed.api(sam, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: sam.email, password: sam.password }) });
  const sessionCookie = signedIn.response.headers.getSetCookie().find((value) => value.includes("session_token="))?.split(";")[0] ?? "";
  if (!signedIn.response.ok || !sessionCookie.includes("=")) throw new Error(`Could not sign Sam in: HTTP ${signedIn.response.status}`);

  /** Completes Google sign-in through Den's real OAuth routes, as the browser would. */
  async function signInToGoogleCloud() {
    const start = await seed.api(sam, `/v1/inference-providers/${googleCloudId}/oauth/start?credentialSetId=${encodeURIComponent(credentialSetId)}`, { headers: { accept: "application/json" } });
    const attempt = new URL(text(record(start.body).authUrl, "sign-in link")).searchParams.get("attempt") ?? "";
    const browserStart = await fetch(`${den.ref.apiUrl}/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`, { headers: { cookie: sessionCookie, accept: "application/json" } });
    const authorize = new URL(text(record(await browserStart.json()).authUrl, "Google address"));
    const callback = new URL(text(authorize.searchParams.get("redirect_uri"), "callback"));
    const state = text(authorize.searchParams.get("state"), "state");
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", `approved.${state}`);
    const done = await fetch(callback, { headers: { cookie: sessionCookie } });
    if (!done.ok) throw new Error(`Google sign-in did not finish: HTTP ${done.status}`);
  }
  if (options.signedIn) await signInToGoogleCloud();

  const { app, browserUrls } = await desktopWithExternalOpenCapture(seed, den, "sam");
  if (options.defaultToGemini || options.signedIn) {
    // Sam's default model is Gemini 2.5 Pro, as it would be after the company set it up.
    // TODO(primitive): seed a desktop's default model before boot.
    await seed.evalIn(app, browserScript((ref, providerID, modelID) => {
      let preferences: unknown = {};
      try { preferences = JSON.parse(localStorage.getItem("openwork.preferences") ?? "{}"); } catch {}
      const base = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? preferences : {};
      localStorage.setItem("openwork.preferences", JSON.stringify({ ...base, defaultModel: { providerID, modelID }, modelVariant: null }));
      localStorage.setItem("openwork.defaultModel", ref);
    }, [`${googleCloudId}/${geminiProId}`, googleCloudId, geminiProId]));
    await reload(app);
  }

  const web = await seed.web({ den, signedInAs: sam, startPath: "/dashboard/library", headless: true, viewport: { width: 1280, height: 800 } });
  const separator = sessionCookie.indexOf("=");
  const applied = record(await web.client.send("Network.setCookie", {
    name: sessionCookie.slice(0, separator), value: sessionCookie.slice(separator + 1), url: den.ref.webUrl, path: "/", httpOnly: true,
  }));
  if (applied.success !== true) throw new Error("Could not give the browser Sam's Den session cookie.");
  const webTarget = (await listTargets(web.handle.cdpUrl)).find((entry) => entry.id === web.client.targetId);
  if (!webTarget) throw new Error("The browser tab is missing.");
  const webSocketDebuggerUrl = debuggerUrlFor(web.handle.cdpUrl, webTarget);

  async function memberConnection(session: DenSession) {
    const result = await seed.api(session, "/v1/inference-providers/member-connections");
    return list(record(result.body).connections).find((entry) => entry.providerId === googleCloudId) ?? null;
  }

  return Object.assign({
    den, app, web, sam, googleCloudId, anthropicId, credentialSetId, geminiProId, geminiProName,
    googleAccount: GOOGLE_ACCOUNT, answer: ANSWER,
    /** Sign-in pages the desktop asked the system browser to open. */
    signInLinks: async () => (await browserUrls.opened()).filter((url) => url.includes("/gateway/connect?attempt=")),
    /** Google's side of sign-in in the browser tab. */
    googleAnswers: (decision: "approve" | "deny") => answerGoogleSignIn({ webSocketDebuggerUrl }, decision),
    googleTokenExchanges: google.exchanges,
    gatewayRequests: gateway.requests,
    /** Google signs Sam out: the Gateway now refuses Google Cloud requests. */
    googleSignsSamOut: () => gateway.signOut(googleCloudId, credentialSetId),
    memberConnection: () => memberConnection(sam),
    browser: web satisfies Surface,
  }, {
    async [Symbol.asyncDispose]() {
      await gateway.stop();
      await google.stop();
    },
  });
}

export const modelsSignInFirstChat = (seed: Seed, ctx: { place: Place }) => modelsSignIn(seed, ctx, { defaultToGemini: true });
export const modelsSignInSignedIn = (seed: Seed, ctx: { place: Place }) => modelsSignIn(seed, ctx, { signedIn: true });
