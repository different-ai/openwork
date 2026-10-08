import { localMysqlIsRunning, localRedisIsRunning, needs, SkipError, type Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function organizationDirectory(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.orgs)) throw new Error("Expected organization directory");
  const orgs = value.orgs.map((org: unknown) => {
    if (!isRecord(org) || typeof org.id !== "string" || typeof org.name !== "string") {
      throw new Error("Expected organization identity");
    }
    return { id: org.id, name: org.name };
  });
  return { orgs, activeOrgId: typeof value.activeOrgId === "string" ? value.activeOrgId : null };
}

export async function orgSelection(seed: Seed, { place }: { place: { kind: "local" | "daytona" } }) {
  if (place.kind === "local" && !process.env.OPENWORK_EVAL_DEN_API_URL) {
    needs({ commands: ["pnpm", "bun"] });
    if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306; run pnpm dev:den:mysql");
    if (!await localRedisIsRunning()) throw new SkipError("Redis at DATABASE_REDIS_URL or redis://127.0.0.1:6379");
  }
  const firstName = "Example Design Team";
  const secondName = "Example Research Team";
  const den = await seed.den({
    env: {
      DEN_ORG_MODE: "multi_org",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "",
      SMTP_HOST: "",
    },
    org: {
      name: firstName,
      admin: {
        name: "Alex Example",
        email: `org-selection-${Date.now()}@example.test`,
        password: "OpenWork-selection-4821!proof",
      },
    },
  });
  const created = await seed.api(den.admin, "/v1/org", {
    method: "POST", body: JSON.stringify({ name: secondName }),
  });
  if (!created.response.ok) throw new Error(`Second organization: HTTP ${created.response.status}`);
  const listed = await seed.api(den.admin, "/v1/me/orgs");
  if (!listed.response.ok) throw new Error(`Organization directory: HTTP ${listed.response.status}`);
  const directory = organizationDirectory(listed.body);
  const first = directory.orgs.find((org) => org.name === firstName);
  const second = directory.orgs.find((org) => org.name === secondName);
  if (!first || !second || directory.orgs.length !== 2) throw new Error("Expected exactly two isolated organizations");
  // The chooser switches organizations through Better Auth's cookie-authenticated
  // endpoint. seed.web(signedInAs) supplies only localStorage's bearer token, so
  // seed both credentials from one real sign-in and observe that same session.
  const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
    method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  if (!signedIn.response.ok || !isRecord(signedIn.body) || typeof signedIn.body.token !== "string") {
    throw new Error(`Browser sign-in: HTTP ${signedIn.response.status}`);
  }
  const owner = { ...den.admin, token: signedIn.body.token };
  const sessionCookie = signedIn.response.headers.getSetCookie()
    .find((value) => value.split(";")[0]?.split("=")[0]?.endsWith("session_token"))?.split(";")[0] ?? "";
  const separator = sessionCookie.indexOf("=");
  if (separator < 1) throw new Error("Browser sign-in did not return a session cookie");
  const selected = await seed.api(owner, "/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId: first.id }),
  });
  if (!selected.response.ok) throw new Error(`Initial organization: HTTP ${selected.response.status}`);

  // ENG-646: enter through AuthScreen, not a direct /dashboard document load.
  // An already-active org means the chooser must come from the real auth
  // client's pending-selection handshake, not merely a missing active org.
  // No injected picker state, mocked React hooks, or forced client navigation.
  const web = await seed.web({ den, signedInAs: owner, startPath: "/", headless: true });
  const applied = await web.client.send("Network.setCookie", {
    name: sessionCookie.slice(0, separator),
    value: sessionCookie.slice(separator + 1),
    url: den.ref.webUrl,
    path: "/",
    httpOnly: true,
    secure: new URL(den.ref.webUrl).protocol === "https:",
  });
  if (!isRecord(applied) || applied.success !== true) throw new Error("Could not seed the browser session cookie");
  return {
    den, web, owner, first, second,
    // TODO(primitive): probe has no document identity observer. A read-only
    // timeOrigin witness catches full reloads that would mask hook-order bugs.
    async documentStartedAt(): Promise<number> {
      const value = await seed.evalIn(web, () => performance.timeOrigin);
      if (typeof value !== "number") throw new Error("Expected a document time origin");
      return value;
    },
  };
}
