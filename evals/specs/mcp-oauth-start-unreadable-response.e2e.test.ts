import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { oauthStartUnreadableWeb } from "../worlds/mcp-oauth-start-unreadable.ts";

// A member clicks Connect and den-api's OAuth-start answer never reaches the
// page: the browser withholds a cross-origin error response whose CORS headers
// do not fit a credentialed request (an edge 502 without them, a wildcard, or
// no response at all). The dashboard must say so in plain words instead of
// echoing the browser's "Failed to fetch", and it must not pretend the provider
// was involved. With the response readable again the same button starts the
// provider sign-in.
const test = spec.world(oauthStartUnreadableWeb, { timeout: 600_000, needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" } });

const unreadableMessage = /OpenWork could not read the answer from its API when starting the sign-in/;
const connectButton = { role: "button", label: "Connect" } as const;

test("the connections page explains an OAuth-start answer the browser could not read, then connects once it can", async ({ world, user, probe, evidence, step }) => {
  await user.see({ text: "Synthetic calendar provider" }, { timeoutMs: 90_000 });
  await user.see(connectButton, { timeoutMs: 30_000 });
  const proxied = async () => (await world.proxy.requestLog()).filter((entry) => entry.path === world.startPath);
  expect(await world.authorizeRequests()).toBe(0);

  await step("den-api's own handshake failure is readable and explained", async () => {
    // The provider disappears after the connection was saved: den-api answers
    // its structured 502 through the proxy, with CORS headers, so the row shows
    // the diagnostic reference. This also lets the browser cache the preflight
    // for this exact URL, so the next fault can land on the GET itself.
    await world.stopProvider();
    await user.click(connectButton);
    await user.see({ text: /Could not connect "Synthetic calendar provider"/ }, { timeoutMs: 30_000 });
    await user.see({ text: /Reference: / });
    await user.notSee({ text: unreadableMessage });
    await user.notSee({ text: /Failed to fetch/ });
    const readable = await proxied();
    expect(readable.some((entry) => entry.method === "OPTIONS" && !entry.faulted && entry.status === 204)).toBe(true);
    expect(readable.some((entry) => entry.method === "GET" && !entry.faulted && entry.status === 502)).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A readable handshake failure shows den-api's diagnostic",
      "With the provider unreachable, the preflight passed (204) and den-api's own HTTP 502 was forwarded unchanged; the connection row shows the structured message with a diagnostic reference, not the readability or browser text.",
      true,
    );
  });

  await step("an OAuth-start answer the browser cannot read is explained in plain words", async () => {
    // The injected answer carries Access-Control-Allow-Origin: * which a
    // credentialed request may not read, so the page sees only a fetch failure.
    await world.proxy.faults.status(world.startPath, 502, { times: 1, body: { error: "bad_gateway" } });
    const before = (await proxied()).length;
    await user.click(connectButton);
    await user.see({ text: unreadableMessage }, { timeoutMs: 30_000 });
    await user.notSee({ text: /Failed to fetch/ });
    await user.notSee({ text: /Reference: / });
    await user.screenshot();
    const faulted = (await proxied()).slice(before).filter((entry) => entry.faulted);
    expect(faulted).toHaveLength(1);
    expect(faulted[0]).toMatchObject({ method: "GET", status: 502 });
    evidence.recordAssertionEvidence(
      "An unreadable OAuth-start answer is explained in plain words",
      `The proxy answered the OAuth-start GET (not its preflight) with an injected HTTP 502 the browser could not read; the connection row shows the readability message instead of "Failed to fetch" or a den-api diagnostic.`,
      true,
    );
  });

  await step("the same Connect starts the provider sign-in once the answer is readable", async () => {
    await world.proxy.faults.clear();
    await world.restartProvider();
    expect(await world.authorizeRequests()).toBe(0);
    const before = (await proxied()).length;
    await user.click(connectButton);
    await probe.eventually(() => world.authorizeRequests(), { within: 60_000, label: "provider authorization request", until: (count) => count >= 1 });
    await user.notSee({ text: unreadableMessage });
    await user.notSee({ text: /Reference: / });
    const forwarded = (await proxied()).slice(before);
    expect(forwarded.some((entry) => entry.method === "GET" && !entry.faulted && entry.status === 200)).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A readable OAuth-start answer starts the provider sign-in",
      "With the fault cleared and the provider back, the proxied OAuth-start GET returned HTTP 200, the synthetic provider received an authorization request, and neither failure message remained.",
      true,
    );
  });
});
