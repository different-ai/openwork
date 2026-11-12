import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Real password accounts and sign-in; the Google client is synthetic (no external OAuth claim). */
export async function passwordSignInGoogle(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "Example workspace",
      admin: { name: "Example Owner" },
      members: { returning: { name: "Returning Member" } },
    },
    env: {
      DEN_ORG_MODE: "multi_org",
      DEN_DEPLOYMENT: "cloud",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
      GOOGLE_CLIENT_ID: "synthetic-google-client",
      GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
      OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "",
      SMTP_HOST: "",
    },
  });
  const account = den.members.returning;
  if (!account) throw new Error("The returning member must be provisioned.");
  const web = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 1440, height: 1000 } });
  const mobile = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 390, height: 844 } });
  // Read-only browser witness: keep only provider and loginHint, never cookies,
  // passwords, response bodies or other requests. No route is mocked.
  const endpoint = mobile.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("The browser must expose its CDP endpoint.");
  const network = new WebSocket(endpoint);
  const socialRequests: Array<{ provider: unknown; loginHint: unknown }> = [];
  network.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (!isRecord(message) || message.method !== "Network.requestWillBeSent" || !isRecord(message.params)) return;
    const request = message.params.request;
    if (!isRecord(request) || typeof request.url !== "string" || new URL(request.url).pathname !== "/api/auth/sign-in/social" || typeof request.postData !== "string") return;
    const body: unknown = JSON.parse(request.postData);
    if (isRecord(body)) socialRequests.push({ provider: body.provider, loginHint: body.loginHint });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser network observer did not connect")), 10_000);
    network.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    network.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser network observer failed")); }, { once: true });
  });
  network.send(JSON.stringify({ id: 1, method: "Network.enable" }));
  return {
    den, web, mobile, account,
    socialRequests: () => [...socialRequests],
    async [Symbol.asyncDispose]() { network.close(); },
    async rollout(enabled: boolean, killed = false) {
      const result = await denFetch(den.admin, "/v1/admin/features/passwordSignInGoogle", {
        method: "PUT",
        headers: { authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled, killed }),
      });
      if (!result.response.ok) throw new Error(`Change sign-in rollout: ${result.text}`);
    },
  };
}
