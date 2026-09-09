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
  const authorizeRequests = async () => (await world.den.mocks.connector.requests()).filter((entry) => entry.path === "/authorize").length;
  const proxied = async () => (await world.proxy.requestLog()).filter((entry) => entry.path === world.startPath);
  expect(await authorizeRequests()).toBe(0);

  await step("the OAuth-start answer is withheld from the page", async () => {
    // The injected answer carries Access-Control-Allow-Origin: * which a
    // credentialed request may not read, so the page sees only a fetch failure.
    await world.proxy.faults.status(world.startPath, 502, { times: 1, body: { error: "bad_gateway" } });
    await user.click(connectButton);
    await user.see({ text: unreadableMessage }, { timeoutMs: 30_000 });
    await user.notSee({ text: /Failed to fetch/ });
    await user.notSee({ text: /provider (rejected|refused)/i });
    await user.screenshot();
    const faulted = await proxied();
    expect(faulted.some((entry) => entry.faulted && entry.status === 502)).toBe(true);
    expect(await authorizeRequests()).toBe(0);
    evidence.recordAssertionEvidence(
      "An unreadable OAuth-start answer is explained in plain words",
      `The proxy answered ${world.startPath} with an injected HTTP 502 the browser could not read; the connection row shows the readability message, not "Failed to fetch", and the provider received no authorization request.`,
      true,
    );
  });

  await step("the same Connect works once the answer is readable", async () => {
    await world.proxy.faults.clear();
    await user.click(connectButton);
    await probe.eventually(authorizeRequests, { within: 60_000, label: "provider authorization request", until: (count) => count >= 1 });
    await user.notSee({ text: unreadableMessage });
    const forwarded = (await proxied()).filter((entry) => !entry.faulted);
    expect(forwarded.some((entry) => entry.status === 200)).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A readable OAuth-start answer starts the provider sign-in",
      "With the fault cleared the proxied OAuth-start request returned HTTP 200 and the synthetic provider received an authorization request; the readability message disappeared.",
      true,
    );
  });
});
