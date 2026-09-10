import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { oauthStartUnreadableWeb } from "../worlds/mcp-oauth-start-unreadable.ts";

// A member clicks Connect and gets a real OpenWork tab in the same browser
// window. Readable handshake failures, unreadable cross-origin answers, and a
// provider refusing OpenWork's redirect URI each receive actionable language
// there while the dashboard keeps its inline error. Once the provider accepts
// the redirect URI, the same button starts provider sign-in.
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
    // its structured 424 through the proxy, with CORS headers, so the row shows
    // the diagnostic reference. This also lets the browser cache the preflight
    // for this exact URL, so the next fault can land on the GET itself.
    await world.stopProvider();
    await user.click(connectButton);
    await user.see({ text: /Could not connect "Synthetic calendar provider"/ }, { timeoutMs: 30_000 });
    await user.see({ text: /Reference: / });
    await user.notSee({ text: unreadableMessage });
    await user.notSee({ text: /Failed to fetch/ });
    const tab = await world.signInTab();
    expect(tab).not.toBeNull();
    if (!tab) throw new Error("Expected the OpenWork sign-in tab.");
    const tabUser = user.on(tab);
    await tabUser.see({ text: /Couldn't start the Synthetic calendar provider sign-in/ });
    const targetUrls = await world.pageTargetUrls();
    const tabUrl = targetUrls.find((url) => url.startsWith(`${new URL(world.den.ref.webUrl).origin}/connect/oauth`));
    expect(tabUrl).toBeDefined();
    if (!tabUrl) throw new Error("Expected the sign-in tab URL.");
    expect(new URL(tabUrl).pathname).toBe("/connect/oauth");
    expect(await world.sameWindowAsDashboard(tab)).toBe(true);
    expect(targetUrls).not.toContain("about:blank");
    const readable = await proxied();
    expect(readable.some((entry) => entry.method === "OPTIONS" && !entry.faulted && entry.status === 204)).toBe(true);
    expect(readable.some((entry) => entry.method === "GET" && !entry.faulted && entry.status === 424)).toBe(true);
    await tabUser.screenshot();
    await world.closeTab(tab);
    evidence.recordAssertionEvidence(
      "A readable handshake failure opens a real diagnostic tab",
      "With the provider unreachable, den-api's own HTTP 424 was forwarded unchanged; a same-window /connect/oauth tab showed the named provider failure, while no about:blank target or unreadable browser text appeared.",
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
    const tab = await world.signInTab();
    expect(tab).not.toBeNull();
    if (!tab) throw new Error("Expected the OpenWork sign-in tab.");
    const tabUser = user.on(tab);
    await tabUser.see({ text: /OpenWork couldn't read its own API's answer/ });
    await tabUser.see({ text: unreadableMessage });
    const targetUrls = await world.pageTargetUrls();
    const tabUrl = targetUrls.find((url) => url.startsWith(`${new URL(world.den.ref.webUrl).origin}/connect/oauth`));
    expect(tabUrl).toBeDefined();
    if (!tabUrl) throw new Error("Expected the sign-in tab URL.");
    expect(new URL(tabUrl).pathname).toBe("/connect/oauth");
    expect(await world.sameWindowAsDashboard(tab)).toBe(true);
    expect(targetUrls).not.toContain("about:blank");
    await tabUser.screenshot();
    await world.closeTab(tab);
    const faulted = (await proxied()).slice(before).filter((entry) => entry.faulted);
    expect(faulted).toHaveLength(1);
    expect(faulted[0]).toMatchObject({ method: "GET", status: 502 });
    evidence.recordAssertionEvidence(
      "An unreadable OAuth-start answer is explained in plain words",
      `The proxy answered the OAuth-start GET (not its preflight) with an injected HTTP 502 the browser could not read; the connection row shows the readability message instead of "Failed to fetch" or a den-api diagnostic.`,
      true,
    );
  });

  await step("the provider refuses OpenWork's redirect URI", async () => {
    await world.restartProvider({ rejectDynamicRedirectUris: "invalid_redirect_uri" });
    const before = (await proxied()).length;
    await user.click(connectButton);
    const tab = await world.signInTab();
    expect(tab).not.toBeNull();
    if (!tab) throw new Error("Expected the OpenWork sign-in tab.");
    const tabUser = user.on(tab);
    await tabUser.see({ text: /Synthetic calendar provider hasn't approved OpenWork yet/ }, { timeoutMs: 30_000 });
    await tabUser.see({ text: /\/v1\/mcp-connections\/oauth\/callback/ });
    await tabUser.see({ text: /Reference/ });
    await tabUser.notSee({ text: /[Tt]ry again/ });
    await tabUser.notSee({ text: unreadableMessage });
    const targetUrls = await world.pageTargetUrls();
    const tabUrl = targetUrls.find((url) => url.startsWith(`${new URL(world.den.ref.webUrl).origin}/connect/oauth`));
    expect(tabUrl).toBeDefined();
    if (!tabUrl) throw new Error("Expected the sign-in tab URL.");
    expect(new URL(tabUrl).pathname).toBe("/connect/oauth");
    expect(await world.sameWindowAsDashboard(tab)).toBe(true);
    expect(targetUrls).not.toContain("about:blank");
    const forwarded = (await proxied()).slice(before);
    expect(forwarded.some((entry) => entry.method === "GET" && !entry.faulted && entry.status === 424)).toBe(true);
    expect(await world.authorizeRequests()).toBe(0);
    await tabUser.screenshot();
    await world.closeTab(tab);
    evidence.recordAssertionEvidence(
      "A rejected redirect URI identifies the provider action",
      "The non-faulted OAuth-start GET returned HTTP 424, no provider authorization request followed, and the same-window OpenWork tab named the redirect URI and diagnostic reference without retry or unreadable-response advice.",
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
