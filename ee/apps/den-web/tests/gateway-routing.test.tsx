import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GatewayRouterSummary } from "@openwork/types/den/gateway-router";
import * as requests from "../app/(den)/_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../app/(den)/_lib/org-scope";
import { newRouter, routerRequest, saveRouter, validateRouter } from "../app/(den)/dashboard/_components/gateway-router-data";
import { RouterEditor, RoutingWorkspace } from "../app/(den)/dashboard/_components/gateway-routing-screen";

const suffix = "01arz3ndektsv4rrffq69g5fav";
const targets = [{ inferenceProviderId: `ipr_${suffix}`, model: `gwm_${suffix}_${suffix}_${suffix}`, name: "Test model", providerName: "Test provider" }];

test("empty, blocked and refresh-error states keep the next action visible", async () => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const request = spyOn(requests, "requestJson").mockResolvedValue({ response: new Response(null, { status: 500 }), payload: null, text: "" });
  try {
    client.setQueryData(["gateway-routers", "org-test"], { routers: [], targets });
    await act(async () => root.render(<QueryClientProvider client={client}><RoutingWorkspace orgId="org-test" /></QueryClientProvider>));
    expect(container.textContent).toContain("No routers yet. Create a router to match prompt categories to models.");
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Create router")?.disabled).toBe(false);
    await act(async () => { client.setQueryData(["gateway-routers", "org-test"], { routers: [], targets: [] }); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("Ask your workspace administrator to grant model access.");
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Create router")?.disabled).toBe(true);
    await act(async () => { await client.refetchQueries({ queryKey: ["gateway-routers", "org-test"] }); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not refresh model routing.");
    expect(container.querySelector("time")?.dateTime).toBeTruthy();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(true);
  } finally {
    await act(async () => root.unmount()); client.clear(); request.mockRestore(); container.remove(); await GlobalRegistrator.unregister();
  }
});
function fixture(): GatewayRouterSummary {
  const draft = newRouter();
  return { ...draft, name: "Work router", routes: draft.routes.map((route, index) => ({ ...route, description: `Category ${index + 1}`, inferenceProviderId: targets[0].inferenceProviderId, model: targets[0].model })), id: `gwr_${suffix}`, revision: 3, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("category bounds, confidence and revoked targets block save without substitutions", () => {
  const router = fixture();
  expect(router.minConfidence).toBe(0.6);
  expect(new Set(router.routes.map(route => route.id)).size).toBe(2);
  expect(router.routes.every(route => route.id.length <= 64)).toBe(true);
  expect(validateRouter(router, targets)).toBeNull();
  expect(validateRouter(router, [])).toContain("available model");
  expect(validateRouter({ ...router, status: "disabled" }, [])).toBeNull();
  expect(validateRouter({ ...router, status: "disabled", minConfidence: NaN }, [])).toContain("0 to 1");
  expect(validateRouter({ ...router, status: "disabled", fallbackRouteId: "removed" }, [])).toContain("fallback");
  expect(validateRouter({ ...router, routes: router.routes.slice(0, 1) }, targets)).toContain("2 to 12");
  expect(validateRouter({ ...router, routes: Array(13).fill(router.routes[0]) }, targets)).toContain("2 to 12");
  expect(validateRouter({ ...router, minConfidence: NaN }, targets)).toContain("0 to 1");
  expect(validateRouter({ ...router, fallbackRouteId: "removed" }, targets)).toContain("fallback");
});

test("client uses explicit organization scope, gwm aliases and optimistic revision", async () => {
  const router = fixture();
  const payload = { router: { ...router, revision: 4 } };
  const request = spyOn(requests, "requestJson").mockResolvedValue({ response: Response.json(payload), payload, text: JSON.stringify(payload) });
  try {
    expect((await saveRouter("org-test", router, router)).revision).toBe(4);
    const [path, options] = request.mock.calls[0];
    expect(path).toBe(`/v1/gateway-routers/${router.id}`);
    expect(options?.method).toBe("PUT");
    expect(new Headers(options?.headers).get(ORG_SCOPE_HEADER)).toBe("org-test");
    expect(JSON.parse(String(options?.body)).revision).toBe(3);
    expect(JSON.parse(String(options?.body)).routes[0].model).toBe(targets[0].model);
    request.mockResolvedValue({ response: new Response(null, { status: 401 }), payload: null, text: "" });
    await expect(routerRequest("org-test")).rejects.toThrow("Sign in again");
    request.mockResolvedValue({ response: new Response(null, { status: 409 }), payload: null, text: "" });
    await expect(routerRequest("org-test")).rejects.toThrow("Your edits are still here");
  } finally { request.mockRestore(); }
});

test("editor discloses sharing, preserves unavailable selection and keeps technical details collapsed", async () => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const request = spyOn(requests, "requestJson");
  try {
    await act(async () => root.render(<RouterEditor orgId="org-test" initial={fixture()} targets={[]} onSaved={() => {}} onClose={() => {}} />));
    expect(container.textContent).toContain("I agree to send the latest user text to Jev to choose a model.");
    expect(container.querySelector("h2")?.className).toBe("sr-only");
    expect(container.querySelector("time")?.dateTime).toBe(fixture().updatedAt);
    expect(container.textContent).toContain("Saved model unavailable");
    expect(container.querySelectorAll('[data-testid="router-category"]').length).toBe(2);
    expect([...container.querySelectorAll("details")].every(details => !details.open)).toBe(true);
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Save router")?.disabled).toBe(true);
    expect(request).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); request.mockRestore(); container.remove(); await GlobalRegistrator.unregister();
  }
});

test("a revoked model remains visible while disabling succeeds and reactivation is blocked", async () => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const router = fixture();
  const payload = { router: { ...router, status: "disabled", revision: 4 } };
  const request = spyOn(requests, "requestJson").mockResolvedValue({ response: Response.json(payload), payload, text: JSON.stringify(payload) });
  try {
    await act(async () => root.render(<RouterEditor orgId="org-test" initial={router} targets={[]} onSaved={() => {}} onClose={() => {}} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Router active"]')?.click());
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Save router")?.disabled).toBe(false);
    await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledTimes(1);
    const [path, options] = request.mock.calls[0];
    expect(path).toBe(`/v1/gateway-routers/${router.id}`);
    expect(options?.method).toBe("PUT");
    expect(JSON.parse(String(options?.body))).toMatchObject({ status: "disabled", revision: 3, routes: router.routes });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved");
    expect(container.textContent).toContain("Saved configuration only. No live request has been tested here.");
    expect(container.textContent).toContain("Saved model unavailable");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Router active"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Acknowledge prompt sharing with Jev"]')?.click());
    await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain("Choose an available model for every category.");
    expect(container.textContent).toContain("Saved model unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); request.mockRestore(); container.remove(); await GlobalRegistrator.unregister();
  }
});

test("a late save preserves newer category edits and advances the revision", async () => {
  GlobalRegistrator.register();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const router = fixture();
  const payload = { router: { ...router, revision: 4 } };
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request = spyOn(requests, "requestJson").mockImplementation(async () => {
    await gate;
    return { response: Response.json(payload), payload, text: JSON.stringify(payload) };
  });
  try {
    await act(async () => root.render(<RouterEditor orgId="org-test" initial={router} targets={targets} onSaved={() => {}} onClose={() => {}} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Acknowledge prompt sharing with Jev"]')?.click());
    await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Add category")?.click());
    await act(async () => { release(); await gate; });
    expect(container.querySelectorAll('[data-testid="router-category"]').length).toBe(3);
    expect(container.textContent).toContain("newer unsaved changes");
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    release(); await act(async () => root.unmount()); request.mockRestore(); container.remove(); await GlobalRegistrator.unregister();
  }
});
