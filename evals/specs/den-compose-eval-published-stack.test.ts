import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denComposePublished } from "../worlds/den-compose-published.ts";

// What a customer following packages/docs/self-host/evaluate-with-docker-compose.mdx
// gets today: the documented docker-compose.eval.yml with its published,
// digest-pinned images, booted pull-only in the private first-administrator
// shape. No image is swapped, so a merged source fix counts only once the
// compose file pins an image that ships it.
//
// Opt-in (OPENWORK_EVAL_PUBLISHED_COMPOSE=1): the world pulls ~1 GB of
// published images, which PR CI must not do on every run.
const test = spec.world(denComposePublished, {
  needs: { commands: ["docker"], optIn: ["OPENWORK_EVAL_PUBLISHED_COMPOSE"] },
  timeout: 600_000,
});

// Minimal cookie jar: den-web's /api/auth/* proxy sets the session cookie on the
// web origin, and the /setup page relies on the browser sending it back.
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }
}

function location(response: Response): URL {
  const value = response.headers.get("location");
  if (!value) throw new Error(`Expected a Location header, got ${response.status} without one.`);
  return new URL(value, response.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}

interface BrowserLike {
  webUrl: string;
  apiOrigin: string;
  jar: CookieJar;
}

// Requests shaped like the /setup page issues them: same-origin /api/auth/*
// through den-web's proxy, everything else straight at runtime-config's denApiUrl.
async function browserFetch(browser: BrowserLike, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const url = path.startsWith("/api/auth/") ? `${browser.webUrl}${path}` : `${browser.apiOrigin}${path}`;
  const headers: Record<string, string> = { accept: "application/json", origin: browser.webUrl };
  const cookie = browser.jar.header();
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  browser.jar.absorb(response);
  return response;
}

test("the documented pull-only stack serves readiness, runtime-config and the auth proxy from published images", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  await step("the docs point at the compose definition this checkout ships", async () => {
    expect(world.composeSha256).toBe(world.documented.sha256);
    evidence.recordAssertionEvidence(
      "Documented download matches the checkout",
      `evaluate-with-docker-compose.mdx tells the customer to download commit ${world.documented.commit} and verify ${world.documented.sha256}; the checkout's docker-compose.eval.yml hashes to ${world.composeSha256}.`,
      true,
    );
  });

  await step("the stack pulled the published images the compose file pins, and they carry their release labels", async () => {
    for (const image of world.images) {
      expect(image.reference).toMatch(/^ghcr\.io\/different-ai\/openwork-den-(?:api|web):\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
      expect(image.reference).not.toContain(":latest");
      expect(image.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(image.reference).toContain(`:${image.version}@`);
    }
    evidence.recordAssertionEvidence(
      "Published, digest-pinned images under test",
      world.images.map((image) => `${image.service}: ${image.reference} (revision ${image.revision}, version ${image.version})`).join("; "),
      true,
    );
  });

  await step("readiness, runtime-config and the auth proxy answer 200 from the host", async () => {
    const ready = await fetch(`${world.webUrl}/api/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, checks: { configuration: "ok", upstream: "ok" } });

    const config = await fetch(`${world.webUrl}/api/runtime-config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({
      denApiUrl: world.publicApiOrigin,
      orgMode: "single_org",
      singleOrgAllowPublicSignup: false,
    });

    const session = await fetch(`${world.webUrl}/api/auth/get-session`, { redirect: "manual" });
    expect(session.status).toBe(200);
    expect(session.headers.get("location")).toBeNull();
    expect(await session.json()).toBeNull();
    evidence.recordAssertionEvidence(
      "Web gateway is ready for a browser",
      `GET /api/ready 200 with configuration+upstream ok, /api/runtime-config 200 handing browsers ${world.publicApiOrigin} with public signup disabled, /api/auth/get-session 200 (null session, no redirect).`,
      true,
    );
  });
});

test("the documented private first-administrator bootstrap completes through the web auth proxy with cookies", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  const config = await (await fetch(`${world.webUrl}/api/runtime-config`)).json();
  const browser: BrowserLike = { webUrl: world.webUrl, apiOrigin: readString(config, "denApiUrl"), jar: new CookieJar() };
  expect(browser.apiOrigin).toBe(world.publicApiOrigin);
  const password = `Astra!${randomBytes(12).toString("hex")}`;
  let grant = "";

  await step("/setup is served and reports bootstrap available while nobody else can sign up", async () => {
    const page = await fetch(`${world.webUrl}/setup`);
    expect(page.status).toBe(200);
    const status = await browserFetch(browser, "/v1/auth/bootstrap/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ status: "available" });

    const stranger = await browserFetch(browser, "/api/auth/sign-up/email", { body: { name: "Nobody", email: "nobody@example.com", password } });
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ error: "single_org_signup_disabled" });
    expect(browser.jar.names()).toEqual([]);
    evidence.recordAssertionEvidence(
      "Private deployment starts closed",
      `GET /setup 200; bootstrap status available; an unknown email signing up through the web proxy got HTTP 403 single_org_signup_disabled and no cookie.`,
      true,
    );
  });

  await step("only the configured owner email with the configured one-time code receives a grant", async () => {
    const wrongCode = await browserFetch(browser, "/v1/auth/bootstrap/verify", { body: { email: world.ownerEmail, code: randomBytes(16).toString("hex") } });
    expect(wrongCode.status).toBe(403);
    const wrongEmail = await browserFetch(browser, "/v1/auth/bootstrap/verify", { body: { email: "nobody@example.com", code: world.setupCode } });
    expect(wrongEmail.status).toBe(403);
    const verified = await browserFetch(browser, "/v1/auth/bootstrap/verify", { body: { email: world.ownerEmail, code: world.setupCode } });
    expect(verified.status).toBe(200);
    grant = readString(await verified.json(), "grant");
    expect(grant.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence(
      "Setup code is owner-bound",
      `Wrong code HTTP ${wrongCode.status}, wrong email HTTP ${wrongEmail.status}, configured owner+code HTTP 200 with a grant.`,
      true,
    );
  });

  await step("the account is created through den-web's /api/auth proxy and the session cookie lands on the web origin", async () => {
    const created = await browserFetch(browser, "/api/auth/sign-up/email", {
      body: { email: world.ownerEmail, name: "Evaluation Administrator", password, bootstrapGrant: grant },
    });
    expect(created.status).toBe(200);
    const payload = await created.json();
    expect(readString(payload, "token").length).toBeGreaterThan(0);
    expect(readRecord(payload, "user")).toMatchObject({ email: world.ownerEmail });
    expect(browser.jar.names()).toContain("openwork-den.session_token");

    const session = await browserFetch(browser, "/api/auth/get-session");
    expect(session.status).toBe(200);
    const sessionPayload = await session.json();
    expect(readRecord(sessionPayload, "user")).toMatchObject({ email: world.ownerEmail });

    const install = await fetch(`${world.webUrl}/install`, { headers: { cookie: browser.jar.header() } });
    expect(install.status).toBe(200);
    evidence.recordAssertionEvidence(
      "First administrator signs in with a cookie",
      `POST /api/auth/sign-up/email with the grant answered 200 and set openwork-den.session_token on ${world.webUrl}; /api/auth/get-session with that cookie returns ${world.ownerEmail}; /install (where /setup navigates) answers 200.`,
      true,
    );
  });

  await step("the administrator owns the singleton organization", async () => {
    const orgs = await browserFetch(browser, "/v1/me/orgs");
    expect(orgs.status).toBe(200);
    const payload = await orgs.json();
    const list = isRecord(payload) && Array.isArray(payload.orgs) ? payload.orgs : [];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: "default", role: "owner", memberCount: 1 });
    evidence.recordAssertionEvidence(
      "Owner of the single organization",
      `GET /v1/me/orgs with the web session cookie lists one organization (slug default) with role owner and one member.`,
      true,
    );
  });

  await step("setup closes: the code and grant cannot create another account", async () => {
    const status = await browserFetch(browser, "/v1/auth/bootstrap/status");
    expect(await status.json()).toEqual({ status: "complete" });
    const reuse = await browserFetch(browser, "/v1/auth/bootstrap/verify", { body: { email: world.ownerEmail, code: world.setupCode } });
    expect(reuse.status).toBe(409);
    const stale = new CookieJar();
    const second = await browserFetch({ ...browser, jar: stale }, "/api/auth/sign-up/email", {
      body: { email: "second@example.com", name: "Second", password, bootstrapGrant: grant },
    });
    expect(second.status).toBe(403);
    expect(stale.names()).toEqual([]);
    evidence.recordAssertionEvidence(
      "Bootstrap is single-use",
      `Status complete; reusing the code HTTP ${reuse.status}; a second signup with the spent grant HTTP ${second.status} and no cookie.`,
      true,
    );
  });

  await step("normal password sign-in works after sign-out", async () => {
    const signOut = await browserFetch(browser, "/api/auth/sign-out", { body: {} });
    expect(signOut.status).toBe(200);
    const cleared = await browserFetch(browser, "/api/auth/get-session");
    expect(await cleared.json()).toBeNull();
    const signIn = await browserFetch(browser, "/api/auth/sign-in/email", { body: { email: world.ownerEmail, password } });
    expect(signIn.status).toBe(200);
    const restored = await browserFetch(browser, "/api/auth/get-session");
    expect(readRecord(await restored.json(), "user")).toMatchObject({ email: world.ownerEmail });
    evidence.recordAssertionEvidence(
      "Break-glass password sign-in",
      `sign-out 200 then get-session null; sign-in/email 200 then get-session returns ${world.ownerEmail} again through the web proxy.`,
      true,
    );
  });
});

test("legacy /api/den redirects from the published web image reach a browser-reachable origin", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  await step("the redirect Location must not name the container-internal Den API host", async () => {
    const redirect = await fetch(`${world.webUrl}/api/den/health`, { redirect: "manual" });
    expect(redirect.status).toBe(307);
    const target = location(redirect);
    const web = world.images.find((image) => image.service === "web");
    evidence.recordAssertionEvidence(
      "Observed redirect target of the published den-web image",
      `${web?.reference ?? "web"} (revision ${web?.revision ?? "unknown"}) answered GET /api/den/health with 307 Location ${target.href}; DEN_API_PUBLIC_URL is ${world.publicApiOrigin}, DEN_API_BASE is ${world.internalApiOrigin}.`,
      target.origin === world.publicApiOrigin,
    );
    expect(target.origin).not.toBe(world.internalApiOrigin);
    expect(target.origin).toBe(world.publicApiOrigin);
    expect(target.pathname).toBe("/health");
  });

  await step("following the redirect from the host reaches Den API health", async () => {
    const followed = await fetch(`${world.webUrl}/api/den/health`, { redirect: "follow" });
    expect(followed.status).toBe(200);
    expect(await followed.json()).toMatchObject({ ok: true });
  });
});
