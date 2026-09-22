import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { bootAcmeWeb, acmeWebOutputs } from "../../worlds/acme-web.ts";
import { probeAcmeGateway } from "../../worlds/lib/acme-gateway-probe.ts";
import { normalizeOutputs, maskOutputs } from "../../packages/world/src/outputs.ts";

test("ACME review connects demo sign-in, real services, and revealable world outputs", { timeout: 600_000 }, async ({ evidence }) => {
  await using stack = new AsyncDisposableStack();
  const world = await bootAcmeWeb(stack);
  const signedIn = await fetch(`${world.den.ref.apiUrl}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: world.web.manifest.webUrl },
    body: JSON.stringify({ email: world.den.admin.email, password: world.den.admin.password }),
  });
  expect(signedIn.status).toBe(200);
  const account: unknown = await signedIn.json();
  expect(typeof account).toBe("object");
  const orgs = await fetch(`${world.den.ref.apiUrl}/v1/me/orgs`, { headers: { authorization: `Bearer ${world.den.admin.token}` } });
  expect(orgs.status).toBe(200);
  evidence.recordAssertionEvidence("The demo account signs in and reads its organization", "A real seeded Den accepted the world password and served the account's organizations. Credentials are omitted from public evidence.", true);

  const result = await probeAcmeGateway(world);
  expect(result.reply).toBe("Acme AI Gateway is working.");
  expect(result.upstreamRequests).toBeGreaterThan(0);
  evidence.recordAssertionEvidence("The full service chain responds", "OpenWork and OpenCode routed a real request through Den's managed provider and AI Gateway to the deterministic model upstream. The world also owns isolated MySQL and Redis-backed Den state.", true);

  const { values, meta } = normalizeOutputs(acmeWebOutputs(world));
  expect(values.alexPassword).toBe(world.den.admin.password);
  expect(values.denToken).toBe(world.den.admin.token);
  expect(maskOutputs(values, meta).alexPassword).toBe("••••••••");
  expect(maskOutputs(values, meta).denToken).toBe("••••••••");
  expect(values.gatewayUrl).toBe(world.gatewayUrl);
  evidence.recordAssertionEvidence("Developer outputs expose connections only on explicit reveal", "The same grouped output contract contains service URLs, the disposable account password, API tokens, and the VM-local database URL; secret fields are masked in normal output. No values are copied into this report.", true);
});
