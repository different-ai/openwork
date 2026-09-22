import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GatewayConnect } from "../app/gateway/connect/gateway-connect";
import * as endpoints from "../app/gateway/connect/gateway-browser-endpoint";

async function fixture(run: (container: HTMLDivElement, button: (label: string) => HTMLButtonElement) => Promise<void>, attempt = `entry.${"a".repeat(43)}`) {
  GlobalRegistrator.register({ url: `https://den.example.test/gateway/connect?attempt=${attempt}` });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  try {
    await act(async () => root.render(<GatewayConnect />));
    await run(container, button);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await GlobalRegistrator.unregister();
  }
}

test("browser entry is title-only, with visible same-user and consent risk copy and collapsed technical details", async () => {
  await fixture(async (container) => {
    const title = container.querySelector("h1");
    expect(title?.textContent).toBe("Connect Google");
    expect(title?.parentElement?.querySelector("p")).toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("details > summary")?.textContent).toBe("Technical details");
    const hint = [...container.querySelectorAll("p")].find((item) => item.textContent === "Use the OpenWork account that started Connect.");
    expect(hint).toBeDefined();
    expect(hint?.closest("details")).toBeNull();
    const risk = [...container.querySelectorAll("p")].find((item) => item.textContent?.startsWith("Authorize Google Cloud access for OpenWork"));
    expect(risk?.textContent).toContain("failed sign-in cleanup may revoke previous or other connections");
    expect(risk?.closest("details")).toBeNull();
    expect(container.querySelector('a[target="_blank"]')?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.innerHTML).not.toContain("gradient");
    expect(container.querySelector("main")?.className).toContain("bg-[var(--dls-surface)]");
  });
});

test("browser account mismatch stays inline with a sign-out recovery action", async () => {
  const resolve = spyOn(endpoints, "gatewayBrowserEndpoint").mockImplementation(async (path) => `https://den.example.test${path}`);
  const requests: string[] = [];
  try {
    await fixture(async (container, button) => {
      const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        return url.endsWith("/api/auth/sign-out")
          ? new Response(null, { status: 204 })
          : Response.json({ error: "browser_account_mismatch", message: "Switch to the OpenWork account that started Connect." }, { status: 403 });
      });
      try {
        await act(async () => button("Continue to Google").click());
        expect(container.querySelector('[data-notice-tone="neutral"]')?.textContent).toContain("Switch to the OpenWork account that started Connect.");
        expect(button("Sign out of this browser account").closest("details")).toBeNull();
        await act(async () => button("Sign out of this browser account").click());
        expect(container.textContent).toContain("Signed out. Sign in with the OpenWork account that started Connect");
        expect(requests).toHaveLength(2);
        expect(requests[0]).toContain("/oauth/browser-start?attempt=entry.");
        expect(requests[1]).toBe("https://den.example.test/api/auth/sign-out");
      } finally { fetch.mockRestore(); }
    });
  } finally { resolve.mockRestore(); }
});

test("invalid browser attempts keep the action and actionable error on screen without issuing a request", async () => {
  const resolve = spyOn(endpoints, "gatewayBrowserEndpoint").mockImplementation(async () => { throw new Error("Unexpected endpoint request"); });
  try {
    await fixture(async (container, button) => {
      await act(async () => button("Continue to Google").click());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("This connection link is invalid. Start Connect again in OpenWork.");
      expect(button("Continue to Google").disabled).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
    }, "invalid");
  } finally { resolve.mockRestore(); }
});
