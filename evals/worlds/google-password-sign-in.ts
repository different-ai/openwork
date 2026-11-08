import { fileURLToPath } from "node:url";
import { queryDenDatabase, type Seed, type Place } from "@openwork/env";
import { routeOAuthBrowser } from "../packages/labs/src/oauth-browser.ts";
import { startOAuthProvider } from "@openwork/labs/oauth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an OAuth witness object");
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected OAuth witness rows");
  return value.map(record);
}

/** A real password account + real Den/Better Auth + a loopback-only Google protocol peer.
 * No mocked login-options, social response, callback, session or account-linking code.
 */
export async function googlePasswordSignIn(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL) {
    throw new Error("Google OAuth world requires its own isolated local Den (--local), not an attached deployment");
  }
  const person = { email: "password-member@example.test", name: "Password member", password: "PasswordSignIn123!" };
  const other = { email: "other-member@example.test", name: "Other member", password: "OtherSignIn123!" };
  const clientId = "openwork-oauth-fixture.apps.googleusercontent.com";
  const clientSecret = "synthetic-google-client-secret";
  const provider = await startOAuthProvider({
    clients: [],
    accounts: [
      { sub: "google-password-member", email: person.email, name: person.name, emailVerified: true },
      { sub: "google-other-member", email: other.email, name: other.name, emailVerified: true },
    ],
  });
  try {
    const preload = fileURLToPath(new URL("../packages/labs/src/oauth-fetch-preload.ts", import.meta.url));
    const den = await seed.den({
      org: { name: "Sign-in workspace", admin: person, members: { other } },
      env: {
        GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret,
        GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "",
        OPENWORK_TEST_OAUTH_ORIGIN: provider.baseUrl,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`,
        RESEND_API_KEY: "", SMTP_HOST: "", LOOPS_API_KEY: "", STRIPE_SECRET_KEY: "",
      },
    });
    provider.registerClient({ clientId, clientSecret, redirectUris: [`${den.ref.webUrl}/api/auth/callback/google`] });
    if (!den.database) throw new Error("OAuth account-linking witness requires the world's disposable database");
    const databaseUrl = den.database.url;
    const accountRows = async () => rows(await queryDenDatabase(databaseUrl,
      "SELECT u.id, u.email, a.provider_id, a.account_id FROM user u LEFT JOIN account a ON a.user_id=u.id WHERE u.email IN (?, ?) ORDER BY u.email, a.provider_id",
      [person.email, other.email]));
    const before = rows(await accountRows());
    const personId = before.find((entry) => entry.email === person.email)?.id;
    const otherId = before.find((entry) => entry.email === other.email)?.id;
    if (typeof personId !== "string" || typeof otherId !== "string") throw new Error("Password identities were not seeded");
    const web = await seed.web({ den, headless: true, startPath: "/", viewport: { width: 1440, height: 1100 } });
    const browser = await routeOAuthBrowser(web.client, {
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      localAuthorizationEndpoint: provider.endpoints.authorization,
      interceptPatterns: ["https://*.google.com/*", "https://*.googleapis.com/*"],
    });
    const session = async () => {
      const cookies = rows(record(await web.client.send("Network.getCookies", { urls: [den.ref.webUrl] })).cookies);
      const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
      const response = await fetch(`${den.ref.apiUrl}/api/auth/get-session`, {
        headers: { cookie }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Session witness: HTTP ${response.status}`);
      const body: unknown = await response.json();
      return body === null ? null : record(record(body).user);
    };
    return { den, web, person, other, personId, otherId, before, provider, browser, session, accountRows,
      async [Symbol.asyncDispose]() { await browser[Symbol.asyncDispose](); await provider[Symbol.asyncDispose](); },
    };
  } catch (error) { await provider[Symbol.asyncDispose](); throw error; }
}
