import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReauthDialog } from "../app/(den)/_components/reauth-dialog";

let root: Root;
let container: HTMLDivElement;
let popup: Window;
let closed: boolean;
let blocked: boolean;
const focus = mock(() => undefined);
const verified = mock(async () => undefined);
const cancelled = mock(() => undefined);
const user = { id: "test-admin", email: "admin@example.test", name: "Admin", authProviders: ["sso", "google"] };

let responseUser = user;

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}

beforeEach(async () => {
  GlobalRegistrator.register({ url: "https://app.example.test" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  closed = false;
  blocked = false;
  responseUser = user;
  focus.mockClear();
  verified.mockClear();
  cancelled.mockClear();
  // The browser window is real DOM state; only its external identity-provider lifecycle is controlled.
  popup = window;
  Object.defineProperty(popup, "closed", { configurable: true, get: () => closed });
  spyOn(popup, "close").mockImplementation(() => { closed = true; });
  spyOn(popup, "focus").mockImplementation(focus);
  spyOn(window, "open").mockImplementation(() => blocked ? null : popup);
  spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    return Response.json(path.includes("/sso/resolve") ? { signInUrl: "/sso/test-org" } : { user: responseUser });
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ReauthDialog open user={user} orgContext={null} onCancel={cancelled} onVerified={verified} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  mock.restore();
  await GlobalRegistrator.unregister();
});

test("SSO hands off to one waiting state, can refocus, and completes once", async () => {
  expect(container.textContent).not.toContain("Continue with Google");
  await click("Continue with SSO");
  expect(container.textContent).toContain("Complete sign-in in the other window");
  expect(container.textContent).not.toContain("Continue with SSO");
  expect(container.querySelector("input")).toBeNull();
  await click("Reopen sign-in");
  expect(focus).toHaveBeenCalledTimes(1);
  const nonce = container.querySelector("[role=dialog]")?.getAttribute("data-reauth-nonce");
  await act(async () => window.dispatchEvent(new MessageEvent("message", {
    origin: window.location.origin,
    data: { type: "openwork:reauth-complete", nonce, error: null },
  })));
  expect(verified).toHaveBeenCalledTimes(1);
  expect(closed).toBe(true);
  expect(cancelled).not.toHaveBeenCalled();
});

test("Cancel remains available during SSO and closes the popup without verifying", async () => {
  await click("Continue with SSO");
  await click("Cancel");
  expect(closed).toBe(true);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(verified).not.toHaveBeenCalled();
});

test("blocked popups leave an actionable retry, not a waiting screen", async () => {
  blocked = true;
  await click("Continue with SSO");
  expect(container.textContent).toContain("Allow popups for OpenWork");
  expect(container.textContent).not.toContain("Waiting for confirmation");
  blocked = false;
  await click("Continue with SSO");
  expect(container.textContent).toContain("Waiting for confirmation");
  expect(verified).not.toHaveBeenCalled();
});

test("closing the popup restores sign-in and explains how to retry", async () => {
  await click("Continue with SSO");
  await act(async () => {
    closed = true;
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  expect(container.textContent).toContain("closed before confirmation");
  expect(container.textContent).toContain("Continue with SSO");
  expect(container.textContent).not.toContain("Waiting for confirmation");
  expect(verified).not.toHaveBeenCalled();
});

test("cancelled and unrelated completion messages cannot retry the pending action", async () => {
  await click("Continue with SSO");
  const nonce = container.querySelector("[role=dialog]")?.getAttribute("data-reauth-nonce");
  for (const [origin, messageNonce] of [["https://other.example.test", nonce], [window.location.origin, "wrong-nonce"]]) {
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      origin,
      data: { type: "openwork:reauth-complete", nonce: messageNonce, error: null },
    })));
  }
  expect(verified).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Waiting for confirmation");
  await click("Cancel");
  await act(async () => window.dispatchEvent(new MessageEvent("message", {
    origin: window.location.origin,
    data: { type: "openwork:reauth-complete", nonce, error: null },
  })));
  expect(verified).not.toHaveBeenCalled();
});

test("provider errors restore retry without completing the pending action", async () => {
  await click("Continue with SSO");
  const nonce = container.querySelector("[role=dialog]")?.getAttribute("data-reauth-nonce");
  await act(async () => window.dispatchEvent(new MessageEvent("message", {
    origin: window.location.origin,
    data: { type: "openwork:reauth-complete", nonce, error: "1" },
  })));
  expect(container.textContent).toContain("Sign-in was cancelled or failed");
  expect(container.textContent).toContain("Continue with SSO");
  expect(closed).toBe(true);
  expect(verified).not.toHaveBeenCalled();
});


test("a different authenticated user cannot approve the pending action", async () => {
  await click("Continue with SSO");
  const errorCallback = new URL(popup.location.href).searchParams.get("errorCallbackURL");
  expect(errorCallback).toContain("/reauth/complete?");
  expect(errorCallback).toContain("error=1");
  responseUser = { ...user, id: "another-user", email: "another@example.test" };
  const nonce = container.querySelector("[role=dialog]")?.getAttribute("data-reauth-nonce");
  await act(async () => window.dispatchEvent(new MessageEvent("message", {
    origin: window.location.origin,
    data: { type: "openwork:reauth-complete", nonce, error: null },
  })));
  expect(verified).not.toHaveBeenCalled();
  expect(container.textContent).toContain(`Sign in as ${user.email} to confirm this change.`);
  expect(container.textContent).toContain("Continue with SSO");
});
