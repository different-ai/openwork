import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "@openwork/cdp";
import { freshSession, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Place, type Seed } from "@openwork/env";
import { adminFreeAutoConversionsSchema } from "@openwork/types/den/admin-free-auto";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an API object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown) { if (typeof value !== "string") throw new Error("Expected a string"); return value; }
const root = fileURLToPath(new URL("../../", import.meta.url));
const identityKey = "conversion-fixture-identity-key-not-for-production";
const webhookSecret = "whsec_free_auto_conversion_fixture_not_real";
const digest = (kind: string, value: string) => createHmac("sha256", "openwork-free-inference-digest-v1").update(`${kind}:${value}`).digest("hex");

export async function adminFreeAutoConversionsWorld(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("The conversion journey needs the isolated local Den substrate");
  const gatewayPort = await allocateFreePort(), providerPort = await allocateFreePort();
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`, providerUrl = `http://127.0.0.1:${providerPort}`;
  const provider = spawn(process.execPath, ["evals/packages/labs/src/free-auto-conversion-provider.mjs", String(providerPort)], { cwd: root, stdio: "ignore" });
  let gateway: ReturnType<typeof spawn> | null = null;
  try {
  const guard = new URL("../packages/labs/src/models-egress-guard.mjs", import.meta.url).href;
  const preload = `await import(${JSON.stringify(guard)})`;
  const environment = {
    DEN_ORG_MODE: "multi_org", GATEWAY_ENABLED: "true", GATEWAY_PUBLIC_BASE_URL: gatewayUrl, GATEWAY_PROXY_BASE_URL: gatewayUrl,
    INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_OPENAI_API_KEY: "free-auto-conversion-fixture-unused",
    ANONYMOUS_INFERENCE_ENABLED: "true", ANONYMOUS_ACCOUNTING_IDENTITY_KEY: identityKey,
    ANONYMOUS_TOKEN_SECRET: "conversion-fixture-token-secret-not-for-production",
    DESKTOP_FREE_RELEASE_KEY: "conversion-fixture-release-key-not-for-production",
    ANONYMOUS_UNTAGGED_IP_DAILY_MICRO_USD: "1", ANONYMOUS_UNTAGGED_GLOBAL_DAILY_MICRO_USD: "1000000",
    DEN_DB_ENCRYPTION_KEY: "conversion-fixture-encryption-key-not-for-production",
    BETTER_AUTH_SECRET: "conversion-fixture-auth-secret-not-for-production",
    STRIPE_SECRET_KEY: "sk_test_models_dpa_fixture_not_real", STRIPE_WEBHOOK_SECRET: webhookSecret,
    MODELS_STRIPE_PORT: String(providerPort), MODELS_EGRESS_FILE: seed.tmpPath("conversion-egress") + ".jsonl",
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    PROVISIONER_MODE: "stub", RESEND_API_KEY: "", SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "", DATABASE_REDIS_URL: "",
    OPENWORK_DEV_MODE: "1", NODE_ENV: "test", DB_MODE: "mysql",
  };
  const den = await seed.den({ web: true, env: environment, org: { name: "Conversion Studio", admin: { name: "Conversion Admin" },
    members: { returning: { name: "Returning Free Member" }, control: { name: "Existing Subscriber" } } } });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Requires an isolated conversion database");
  gateway = spawn(process.execPath, ["--conditions=development", "--import", "./ee/apps/den-api/node_modules/tsx/dist/loader.mjs", "ee/apps/gateway/src/server.ts"], {
    cwd: root, env: { ...process.env, ...environment, DATABASE_URL: databaseUrl, PORT: String(gatewayPort) }, stdio: "ignore",
  });
  for (const origin of [providerUrl, gatewayUrl]) {
    const deadline = Date.now() + 60_000;
    while (!(await fetch(`${origin}/health`).then((response) => response.ok).catch(() => false))) {
      if (Date.now() > deadline) throw new Error("The conversion witness did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const organizationId = text(record(org.organization).id);
  const adminMemberId = text(record(org.currentMember).id);
  const returning = den.members.returning, control = den.members.control;
  if (!returning || !control) throw new Error("Missing conversion members");
  const getMember = async (session: DenSession) => record(record((await seed.api(session, "/v1/org")).body).currentMember);
  const returningUserId = text((await getMember(returning)).userId);
  const controlUserId = text((await getMember(control)).userId);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/free-auto", headless: true, viewport: { width: 375, height: 200 } });
  const anonymous = await seed.web({ den, startPath: "/admin/free-auto", headless: true });
  let newSession: DenSession | null = null;
  let newUserId = "", newMemberId = "", newOrganizationId = "";
  const sql = (statement: string, values: (string | number | null)[] = []) => queryDenDatabase(databaseUrl, statement, values);
  const memberStatus = async (session: DenSession, journey: string) => {
    const result = await seed.api(session, "/v1/inference/free/credential", { method: "POST" });
    if (!result.response.ok) throw new Error(`Member credential failed (${result.response.status})`);
    const key = text(record(record(result.body).credential).apiKey);
    const response = await fetch(`${gatewayUrl}/api/v1/auto/status`, { headers: { authorization: `Bearer ${key}`, "x-openwork-free-journey": journey } });
    if (!response.ok) throw new Error(`Member status failed (${response.status})`);
    return record(await response.json());
  };
  const event = async (id: string, userId: string, exhaustedDays: number, authenticatedDays: number | null) => {
    await sql("INSERT INTO free_auto_limit_events (id,audience,subject_hash,user_id,organization_id,window_start_at,exhausted_at,authenticated_at) VALUES (?,'member',?,?,?,UTC_DATE(),DATE_SUB(NOW(3),INTERVAL ? DAY),IF(? IS NULL,NULL,DATE_SUB(NOW(3),INTERVAL ? DAY)))",
      [id, digest("member", userId), userId, organizationId, exhaustedDays, authenticatedDays, authenticatedDays]);
  };
  return {
    den, web, anonymous, returning, organizationId, adminMemberId,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    async conversionReads() {
      // TODO(primitive): probe needs a read-only resource timing projection to
      // witness that below-fold analytics never started, without product mocks.
      return seed.evalIn(web, () => performance.getEntriesByType("resource").filter((entry) =>
        new URL(entry.name).pathname.endsWith("/admin/free-auto/conversions") &&
        "responseStatus" in entry && typeof entry.responseStatus === "number" && entry.responseStatus > 0,
      ).length);
    },
    async anonymousAccess() { return (await fetch(new URL("/v1/admin/free-auto/conversions", den.ref.apiUrl))).status; },
    async report(query = "") {
      const result = await seed.api(den.admin, `/v1/admin/free-auto/conversions?${query}`);
      if (!result.response.ok) throw new Error(`Conversion report failed (${result.response.status}): ${result.text}`);
      return adminFreeAutoConversionsSchema.parse(result.body);
    },
    async exhaustGuest(journey: string) {
      // Arrangement only: exhaust the real localhost IP bucket. The product status route records the journey.
      const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const ip = createHmac("sha256", identityKey).update("ip:127.0.0.1").digest("hex");
      const identity = digest("untagged-ip", ip);
      const id = digest("free", ["usage", "installation", identity, "daily", start.toISOString()].join(":"));
      await sql("INSERT INTO anonymous_inference_usage_buckets (id,scope,identity_hash,window_type,window_start_at,window_end_at,limit_amount,used_amount) VALUES (?,'installation',?,'daily',?,DATE_ADD(?,INTERVAL 1 DAY),100,100) ON DUPLICATE KEY UPDATE used_amount=100", [id, identity, start.toISOString().slice(0, 23).replace("T", " "), start.toISOString().slice(0, 23).replace("T", " ")]);
      const response = await fetch(`${gatewayUrl}/api/anonymous/status`, { headers: { authorization: "Bearer public", "x-openwork-free-journey": journey } });
      return { status: response.status, body: record(await response.json()) };
    },
    async exhaustedCheckWhileAnalyticsLocked(journey: string) {
      const ip = createHmac("sha256", identityKey).update("ip:127.0.0.1").digest("hex");
      const rateId = digest("free-auto-observation-rate", `${ip}:${Math.floor(Date.now() / 86_400_000)}`);
      const rows = await sql("SELECT COUNT(*) AS total FROM anonymous_inference_rate_buckets WHERE id = ?", [rateId]);
      if (Number(record(rows[0]).total) !== 1) throw new Error("Expected this network's guest observation bucket");
      // Arrangement only: hold the analytics row lock for eight seconds, as a slow or contended analytics write would.
      const lock = sql("SELECT SLEEP(8) AS held FROM anonymous_inference_rate_buckets WHERE id = ? FOR UPDATE", [rateId]);
      await new Promise((resolve) => setTimeout(resolve, 750));
      const started = Date.now();
      const response = await fetch(`${gatewayUrl}/api/anonymous/status`, { headers: { authorization: "Bearer public", "x-openwork-free-journey": journey } });
      const body = record(await response.json());
      const elapsedMs = Date.now() - started;
      await lock;
      return { status: response.status, state: body.state, elapsedMs };
    },
    async createAccountAndReturn(journey: string) {
      const email = `conversion-new-${Date.now()}@example.test`;
      const response = await fetch(`${den.ref.apiUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
        body: JSON.stringify({ email, name: "New Free Customer", password: den.admin.password }) });
      if (!response.ok) throw new Error(`New customer signup failed (${response.status})`);
      const body = record(await response.json()); newUserId = text(record(body.user).id);
      newSession = { ...den.ref, token: text(body.token), email, password: den.admin.password };
      const created = await seed.api(newSession, "/v1/org", { method: "POST", body: JSON.stringify({ name: "New Customer Studio" }) });
      if (!created.response.ok) throw new Error("Could not create the new customer's organization");
      const context = record((await seed.api(newSession, "/v1/org")).body);
      newMemberId = text(record(context.currentMember).id); newOrganizationId = text(record(context.organization).id);
      return memberStatus(newSession, journey);
    },
    async returnExisting(journey: string) { return memberStatus(returning, journey); },
    async returningSignIn() {
      await event("returning-member-event", returningUserId, 3, null);
      await freshSession(returning);
    },
    async boundaries() {
      await event("prepaid-member-event", controlUserId, 2, null);
      // A renewal paid after the limit belongs to a subscription started earlier and cannot qualify.
      await sql("INSERT INTO free_auto_purchases (subscription_id,user_id,organization_id,type,started_at,paid_at) VALUES ('sub_old',?,?,'inference',DATE_SUB(NOW(3),INTERVAL 40 DAY),NOW(3))", [controlUserId, organizationId]);
      await event("outside-range-event", controlUserId, 70, 69);
      for (let index = 0; index < 52; index += 1) await sql("INSERT INTO free_auto_limit_events (id,audience,subject_hash,window_start_at,exhausted_at) VALUES (?,'guest',?,UTC_DATE(),DATE_SUB(NOW(3),INTERVAL 10 DAY))", [`unlinked-${index}`, digest("fixture", String(index))]);
      // Another event for the same returning account must not add another person.
      await event("returning-member-duplicate", returningUserId, 4, 3);
    },
    async guestObservationCap() {
      let exhausted = 0;
      // Change every client-controlled header; the Gateway must use its own network identity for this bound.
      // Concurrent requests exercise the shared database lock as well as sequential retries.
      for (let batch = 0; batch < 30; batch += 1) {
        const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => fetch(`${gatewayUrl}/api/anonymous/status`, {
          headers: { authorization: "Bearer public", "x-openwork-free-journey": digest("rotating-client", String(batch * 4 + index)) },
        }).then(async (response) => ({ status: response.status, body: record(await response.json()) }))));
        exhausted += responses.filter((response) => response.status === 200 && response.body.state === "exhausted").length;
      }
      const rows = await sql("SELECT COUNT(*) AS total FROM free_auto_limit_events WHERE audience='guest' AND id REGEXP '^[a-f0-9]{64}$'");
      return { exhausted, observations: Number(record(rows[0]).total) };
    },
    async purchase(paid: boolean) {
      if (!newSession) throw new Error("Expected a signed-in customer");
      const now = Math.floor(Date.now() / 1000);
      const subscription = { id: "sub_free_auto_conversion", object: "subscription", status: "active", created: now,
        customer: "cus_free_auto_conversion", metadata: { org_id: newOrganizationId, created_by_org_member_id: newMemberId, subscription_type: "inference" },
        items: { data: [{ id: "si_free_auto", quantity: 1, price: { id: "price_free_auto" }, current_period_start: now, current_period_end: now + 2_592_000 }] },
        cancel_at_period_end: false, canceled_at: null, ended_at: null, latest_invoice: "in_free_auto_conversion" };
      await fetch(`${providerUrl}/fixture`, { method: "POST", body: JSON.stringify({ subscription, paid }) });
      const postEvent = async (type: string, object: unknown, suffix: string) => {
        const payload = JSON.stringify({ id: `evt_conversion_${suffix}`, object: "event", type, created: now, data: { object } });
        const signature = createHmac("sha256", webhookSecret).update(`${now}.${payload}`).digest("hex");
        const response = await fetch(`${den.ref.apiUrl}/v1/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${now},v1=${signature}` }, body: payload });
        if (!response.ok) throw new Error(`Payment event failed (${response.status}): ${await response.text()}`);
      };
      await postEvent("customer.subscription.created", subscription, "created");
      await postEvent("invoice.paid", { id: "in_free_auto_conversion", object: "invoice", parent: { subscription_details: { subscription: subscription.id } } }, paid ? "paid" : "unpaid");
      return newUserId;
    },
    async [Symbol.asyncDispose]() { gateway?.kill("SIGTERM"); provider.kill("SIGTERM"); },
  };
  } catch (error) { gateway?.kill("SIGTERM"); provider.kill("SIGTERM"); throw error; }
}
