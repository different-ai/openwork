import { expect } from "vitest";
import { browserScript, server, test } from "@openwork/testkit";
import { addInitScript, setViewport } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { clickText, evalIn, waitFor } from "@openwork/behaviors";

declare global {
  interface Window {
    ssoRequests: Array<{
      url: string;
      method: string;
      credentials: RequestCredentials;
      headers: Record<string, string>;
      body: unknown;
      reply(status: number, body: unknown): void;
      fail(): void;
    }>;
  }
}

test("SSO handoff keeps the shared status screen and supports manual navigation and retry", { timeout: 600_000 }, async ({ place, evidence }) => {
  await using den = await server({ place, provision: false });
  await using browser = await chrome({ host: place.host(), startUrl: "about:blank", headless: true });
  // Only the SSO endpoint is controlled. Next routing, runtime config, requestJson,
  // page effects and the shared status component all run in the real Den app.
  await using witness = await addInitScript(browser.client, () => {
    window.ssoRequests = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname !== "/api/auth/sign-in/sso") return originalFetch(input, init);
      const body: unknown = JSON.parse(await request.text());
      return new Promise<Response>((resolve, reject) => {
        window.ssoRequests.push({
          url: request.url, method: request.method, credentials: request.credentials,
          headers: Object.fromEntries(request.headers), body,
          reply: (status, payload) => resolve(new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status })),
          fail: () => reject(new TypeError("Network unavailable")),
        });
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    };
  });
  const navigate = async (path: string) => {
    await browser.client.send("Page.navigate", { url: new URL(path, den.ref.webUrl).toString() });
  };
  const pending = async () => {
    await waitFor(browser, () => (window.ssoRequests?.length > 0 && document.querySelector("h1")?.textContent === "Redirecting you to your organisation’s identity provider"), { timeoutMs: 90_000 });
    expect(await evalIn(browser, () => (document.querySelector('main a, main button, [role="alert"]') === null))).toBe(true);
    expect(await evalIn(browser, () => (document.querySelector("main")?.textContent))).toContain("Redirecting you to your organisation\u2019s identity provider");
  };
  const requestBody = (index: number) => evalIn(browser, browserScript((index) => (window.ssoRequests[index].body), [index]));
  const reply = (index: number, status: number, body: unknown) => evalIn(browser, browserScript((index, status, body) => {
    window.ssoRequests[index].reply(status, body);
  }, [index, status, body]));
  const expectError = async (message: string) => {
    await waitFor(browser, () => Boolean(document.querySelector('[role="alert"]')), { timeoutMs: 10_000 });
    expect(await evalIn(browser, () => (document.querySelector('[role="alert"]')?.textContent))).toBe(message);
    expect(await evalIn(browser, () => (document.querySelector('[role="status"]') === null))).toBe(true);
    expect(await evalIn(browser, () => ([...document.querySelectorAll("main a")].map((link) => link.textContent?.trim())))).toEqual(["Back to sign in"]);
    expect(await evalIn(browser, () => (document.querySelector("main button")?.textContent?.trim()))).toBe("Try again");
    expect(await evalIn(browser, () => location.hash)).toBe("");
  };

  await navigate("/sso/synthetic-team");
  await pending();
  const origin = new URL(den.ref.webUrl).origin;
  expect(await requestBody(0)).toEqual({ organizationSlug: "synthetic-team", callbackURL: `${origin}/` });
  expect(await evalIn(browser, () => {
    const { url, method, credentials, headers } = window.ssoRequests[0];
    return { url, method, credentials, headers };
  })).toEqual({ url: `${origin}/api/auth/sign-in/sso`, method: "POST", credentials: "include", headers: { accept: "application/json", "content-type": "application/json" } });
  expect(await evalIn(browser, () => (document.querySelector("main")?.textContent))).not.toMatch(/synthetic-team|org_|Enterprise SSO|Signing you in|Connecting to your identity provider/);
  // Same-document navigation lets us exercise real location.assign and the real
  // anchor default action while observing the fallback on the interim screen.
  const destination = `${origin}/sso/synthetic-team#identity-provider`;
  await reply(0, 200, { url: destination });
  await waitFor(browser, () => (location.hash === "#identity-provider" && Boolean(document.querySelector("main a"))));
  expect(await evalIn(browser, () => (document.querySelector<HTMLAnchorElement>("main a")?.href))).toBe(destination);
  expect(await evalIn(browser, () => (document.querySelector("main a")?.parentElement?.textContent))).toBe("If the page did not open, click here.");
  await evalIn(browser, () => {
    location.hash = "";
  });
  await waitFor(browser, () => location.hash === "");
  await clickText(browser, "click here");
  await waitFor(browser, () => location.hash === "#identity-provider");
  expect(await evalIn(browser, () => window.ssoRequests.length)).toBe(1);
  evidence.recordAssertionEvidence("Automatic and manual handoff", "The real page sends a credentialed SSO POST, never exposes internal organization identifiers, has no premature fallback, and both location.assign and the fallback anchor reach the returned URL without another request.", true);

  const context = {
    callbackURL: `${origin}/join-org?invite=synthetic-invite&desktopAuth=1`,
    errorCallbackURL: `${origin}/?error=sso&webAuth=1`,
    loginHint: "person+hint@openwork.test",
  };
  await navigate(`/sso/synthetic-team?${new URLSearchParams(context)}`);
  await pending();
  expect(await requestBody(0)).toEqual({ organizationSlug: "synthetic-team", ...context });
  await reply(0, 403, { message: "Provider unavailable" });
  await expectError("Provider unavailable");
  await clickText(browser, "Try again");
  await waitFor(browser, () => (window.ssoRequests.length === 2 && !document.querySelector('[role="alert"]')));
  await pending();
  expect(await requestBody(1)).toEqual(await requestBody(0));
  await reply(1, 200, { url: "#recovered" });
  await waitFor(browser, () => (location.hash === "#recovered" && Boolean(document.querySelector("main a"))));
  expect(await evalIn(browser, () => (document.querySelector('[role="alert"]') === null))).toBe(true);
  expect(await evalIn(browser, () => document.querySelector("main a")?.getAttribute("href"))).toBe("#recovered");
  evidence.recordAssertionEvidence("Retry preserves request context", "A provider error exposes retry and the existing sign-in link; retry removes the error and actions while pending, retains callbackURL/errorCallbackURL/loginHint exactly, and navigates to the new response URL.", true);

  for (const failure of [
    { status: 200, body: {}, message: "SSO sign-in started without a redirect URL." },
    { status: 200, body: { url: 42 }, message: "SSO sign-in started without a redirect URL." },
    { status: 502, body: "not json", message: "Failed to start SSO sign-in (502)." },
  ]) {
    await navigate("/sso/synthetic-team");
    await pending();
    await reply(0, failure.status, failure.body);
    await expectError(failure.message);
  }
  await navigate("/sso/synthetic-team?desktopAuth=1&desktopScheme=openwork&webAuth=1&webAuthReturn=%2Fweb&invite=token&intent=models&mode=sign-in&unrelated=drop");
  await pending();
  expect(await requestBody(0)).toEqual({ organizationSlug: "synthetic-team", callbackURL: `${origin}/?mode=sign-in&desktopAuth=1&desktopScheme=openwork&webAuth=1&webAuthReturn=%2Fweb&invite=token&intent=models` });
  await evalIn(browser, () => window.ssoRequests[0].fail());
  await expectError("Network unavailable");
  evidence.recordAssertionEvidence("Failure handling stays intact", "Missing/non-string redirect URLs, non-JSON error responses and network failures expose retry but no identity-provider link or navigation; the default callback retains supported handoff parameters only.", true);

  const frame = () => evalIn(browser, () => {
    const main = document.querySelector("main");
    const card = main?.lastElementChild;
    if (!main || !card) throw new Error("Status frame missing");
    const bounds = card.getBoundingClientRect();
    return { main: main.className, card: card.className, width: bounds.width, left: bounds.left, background: getComputedStyle(main).backgroundColor };
  });
  for (const width of [390, 1280]) {
    await setViewport(browser, { width, height: 900, deviceScaleFactor: 1 });
    await navigate("/sso/test/complete");
    await waitFor(browser, () => document.querySelector("h1")?.textContent === "Authentication test finished", { timeoutMs: 90_000 });
    const sharedFrame = await frame();
    await navigate("/sso/synthetic-team");
    await pending();
    expect(await frame()).toEqual(sharedFrame);
    await waitFor(browser, () => Boolean(document.querySelector<HTMLImageElement>('main img[src="/openwork-mark.svg"]')?.naturalWidth));
    expect(await evalIn(browser, () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await evalIn(browser, () => (document.querySelector('[data-testid="setup-frame"]') === null))).toBe(true);
  }
  evidence.recordAssertionEvidence("Current shared status frame", "At 390px and 1280px the real SSO page matches the existing SSO completion page's frame classes, width, position and background, loads the brand image and has no horizontal overflow. The login setup frame is not substituted.", true);
});
