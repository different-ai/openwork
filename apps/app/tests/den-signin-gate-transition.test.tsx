/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { initializeDenBootstrapConfig, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import { denSessionUpdatedEvent } from "../src/app/lib/den-session-events";
import { clearOrgSelectionPending, markOrgSelectionPending } from "../src/app/lib/den-sign-in-intent";
import * as auth from "../src/react-app/domains/cloud/den-auth-provider";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { DenSigninGate } = await import("../src/react-app/shell/app-root");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  window.localStorage.clear(); window.sessionStorage.clear();
  await initializeDenBootstrapConfig();
  writeDenSettings({ baseUrl: "https://den.example.test", authToken: "first-fixture-session", activeOrgId: "org-first" }, { persistBootstrap: false });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function Destination() {
  const location = useLocation();
  return <div data-testid="destination">{location.pathname}{location.search}</div>;
}

for (const requireSignin of [true, false]) {
  for (const destination of ["/settings/cloud-account?tab=profile", "/workspace/ws-fixture/session/ses-fixture"]) {
    test.each(["settings", "session"])(`a mounted ${requireSignin ? "required" : "optional"} sign-in gate observes a new org decision without leaving signed_in at ${destination} via %s signal`, async (signal) => {
      await setDenBootstrapConfig({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test", requireSignin });
      const signedIn: auth.DenAuthStore = { status: "signed_in", isSignedIn: true, error: null,
        user: { id: "user-fixture", email: "member@example.test", name: "Member" },
        verifiedIdentity: { principalId: "user-fixture", organizationId: "org-first" }, refresh: async () => {} };
      const useAuth = spyOn(auth, "useDenAuth").mockReturnValue(signedIn);
      const host = document.createElement("div"); document.body.append(host);
      const root = createRoot(host);
      const view = () => <MemoryRouter initialEntries={[destination]}><DenSigninGate><Destination /></DenSigninGate></MemoryRouter>;
      cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
      await act(async () => root.render(view()));
      expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe(destination);
      // A same-status background refresh is not a navigation command.
      await act(async () => {
        writeDenSettings({ baseUrl: "https://den.example.test", authToken: "refreshed-fixture-session", activeOrgId: "org-first" }, { persistBootstrap: false });
        window.dispatchEvent(new CustomEvent(denSessionUpdatedEvent, { detail: { status: "success" } }));
        useAuth.mockReturnValue({ ...signedIn, user: { ...signedIn.user, id: "user-fixture", email: "member@example.test", name: "Updated member" } });
        root.render(view());
      });
      expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe(destination);
      if (signal === "session") {
        // An unresolved org alone is not a navigation command. The later
        // handoff-complete signal must independently publish the new decision.
        await act(async () => writeDenSettings({ baseUrl: "https://den.example.test", authToken: "handoff-fixture-session", activeOrgId: "" }, { persistBootstrap: false }));
        expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe(destination);
      }
      // Both existing notification channels can complete a same-status handoff.
      // Neither requires the auth provider to enter checking or signed_out.
      await act(async () => {
        markOrgSelectionPending({ id: "org-suggested", name: "Suggested organization" });
        if (signal === "settings") {
          writeDenSettings({ baseUrl: "https://den.example.test", authToken: "handoff-fixture-session", activeOrgId: "" }, { persistBootstrap: false });
        } else {
          window.dispatchEvent(new CustomEvent(denSessionUpdatedEvent, { detail: { status: "success" } }));
        }
      });
      expect(useAuth.mock.results.every(result => result.type !== "return" || result.value.status === "signed_in")).toBe(true);
      expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/onboarding");
      await act(async () => {
        clearOrgSelectionPending();
        writeDenSettings({ baseUrl: "https://den.example.test", authToken: "handoff-fixture-session", activeOrgId: "org-first" }, { persistBootstrap: false });
      });
      // Clearing the marker alone must not invent a second navigation either.
      expect(host.querySelector('[data-testid="destination"]')?.textContent).toBe("/onboarding");
    });
  }
}
