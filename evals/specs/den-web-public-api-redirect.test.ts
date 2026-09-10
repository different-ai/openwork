import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denComposeEval } from "../worlds/den-compose-eval.ts";

// Legacy /api/den/* callers (older desktop builds) receive a 307 to the Den API.
// In the documented Compose and Helm shapes den-web's DEN_API_BASE is the
// container-internal upstream that the /api/auth/* proxy needs, so the browser
// must be redirected to DEN_API_PUBLIC_URL instead. Both must hold on one
// container from the host: the redirect lands on a reachable API, and the auth
// proxy keeps answering through the in-network upstream.
const test = spec.world(denComposeEval, {
  needs: { commands: ["docker"], env: ["OPENWORK_EVAL_DEN_WEB_IMAGE"] },
  timeout: 600_000,
});

function location(response: Response): URL {
  const value = response.headers.get("location");
  if (!value) throw new Error(`Expected a Location header, got ${response.status} without one.`);
  return new URL(value, response.url);
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

test("legacy /api/den redirects send the browser to the public API origin while the auth proxy stays in-network", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  await step("the documented web container redirects /api/den/* to DEN_API_PUBLIC_URL, not DEN_API_BASE", async () => {
    const redirect = await fetch(`${world.webUrl}/api/den/health?probe=redirect`, { redirect: "manual" });
    expect(redirect.status).toBe(307);
    const target = location(redirect);
    expect(target.origin).toBe(world.publicApiOrigin);
    expect(target.pathname).toBe("/health");
    expect(target.search).toBe("?probe=redirect");
    expect(target.origin).not.toBe(world.internalApiOrigin);
    evidence.recordAssertionEvidence(
      "Redirect targets the browser-reachable API origin",
      `GET ${world.webUrl}/api/den/health answered 307 with Location origin ${target.origin} (DEN_API_PUBLIC_URL); the in-network ${world.internalApiOrigin} did not leak to the browser.`,
      true,
    );
  });

  await step("following that redirect from the host reaches Den API health", async () => {
    const followed = await fetch(`${world.webUrl}/api/den/health`, { redirect: "follow" });
    expect(followed.status).toBe(200);
    expect(new URL(followed.url).origin).toBe(world.publicApiOrigin);
    expect(await json(followed)).toMatchObject({ ok: true });
    evidence.recordAssertionEvidence(
      "Redirected API call succeeds from outside the compose network",
      `Following the redirect ended at ${followed.url} with HTTP 200 and ok:true.`,
      true,
    );
  });

  await step("the /api/auth/* proxy on the same container still answers through the in-network upstream", async () => {
    const ok = await fetch(`${world.webUrl}/api/auth/ok`, { redirect: "manual" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("location")).toBeNull();
    expect(await json(ok)).toMatchObject({ ok: true });
    const session = await fetch(`${world.webUrl}/api/auth/get-session`, { redirect: "manual" });
    expect(session.status).toBe(200);
    const ready = await fetch(`${world.webUrl}/api/ready`);
    expect(ready.status).toBe(200);
    expect(await json(ready)).toMatchObject({ ok: true, checks: { upstream: "ok" } });
    evidence.recordAssertionEvidence(
      "Auth proxy is unaffected by the public redirect origin",
      `GET /api/auth/ok and /api/auth/get-session answered 200 without a redirect, and /api/ready reported upstream ok, so DEN_API_BASE still serves the server-side proxy.`,
      true,
    );
  });

  await step("runtime-config and the legacy redirect agree on the API origin new and old clients use", async () => {
    const config = await fetch(`${world.webUrl}/api/runtime-config`);
    expect(config.status).toBe(200);
    const payload = await json(config);
    expect(payload).toMatchObject({ denApiUrl: world.publicApiOrigin });
    evidence.recordAssertionEvidence(
      "New and legacy clients are pointed at the same origin",
      `runtime-config denApiUrl equals the /api/den redirect origin ${world.publicApiOrigin}.`,
      true,
    );
  });

  await step("without DEN_API_PUBLIC_URL the documented DEN_API_BASE fallback still applies", async () => {
    const redirect = await fetch(`${world.fallbackWebUrl}/api/den/health`, { redirect: "manual" });
    expect(redirect.status).toBe(307);
    expect(location(redirect).origin).toBe(world.internalApiOrigin);
    const ok = await fetch(`${world.fallbackWebUrl}/api/auth/ok`, { redirect: "manual" });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ ok: true });
    evidence.recordAssertionEvidence(
      "Legacy fallback order is preserved",
      `The same image without DEN_API_PUBLIC_URL redirected to ${world.internalApiOrigin} (DEN_API_BASE) and its auth proxy still answered 200.`,
      true,
    );
  });
});
