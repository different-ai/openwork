import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GatewayConnect } from "../app/gateway/connect/gateway-connect";
import * as endpoints from "../app/gateway/connect/gateway-browser-endpoint";

type BrowserRequest = { url: string; init?: RequestInit };
type Fixture = {
  container: HTMLDivElement;
  button: (label: string) => HTMLButtonElement;
  requests: BrowserRequest[];
  poll: () => Promise<void>;
  focus: () => Promise<void>;
  visibility: (state: DocumentVisibilityState) => Promise<void>;
  unmount: () => Promise<void>;
  timerCount: () => number;
};

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred is not initialized"); };
  let reject: (reason: Error) => void = () => { throw new Error("Deferred is not initialized"); };
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(run: (view: Fixture) => Promise<void>, options: {
  attempt?: string;
  respond?: (request: BrowserRequest) => Response | Promise<Response>;
  endpoint?: (path: string) => Promise<string>;
  strict?: boolean;
} = {}) {
  GlobalRegistrator.register({ url: `https://den.example.test/gateway/connect?attempt=${options.attempt ?? `entry.${"a".repeat(43)}`}` });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const requests: BrowserRequest[] = [];
  const timers = new Map<number, () => void>();
  const browserTimers: Pick<Window, "setInterval" | "clearInterval"> = window;
  const browserNetwork: Pick<Window, "fetch"> = globalThis;
  let timerId = 0;
  const interval = spyOn(browserTimers, "setInterval").mockImplementation((handler) => {
    if (typeof handler !== "function") throw new Error("Expected timer callback");
    const id = ++timerId;
    timers.set(id, () => handler());
    return id;
  });
  const clearInterval = spyOn(browserTimers, "clearInterval").mockImplementation((id) => { if (id !== undefined) timers.delete(id); });
  const endpoint = spyOn(endpoints, "gatewayBrowserEndpoint").mockImplementation(options.endpoint ?? (async (path) => `https://den.example.test${path}`));
  const fetch = spyOn(browserNetwork, "fetch").mockImplementation(async (input, init) => {
    const request = { url: input instanceof Request ? input.url : String(input), init };
    requests.push(request);
    return options.respond ? options.respond(request) : Response.json({ status: "ready" });
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
  };
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  try {
    await act(async () => root.render(options.strict ? <StrictMode><GatewayConnect /></StrictMode> : <GatewayConnect />));
    await run({
      container, button, requests, unmount,
      poll: () => act(async () => { for (const callback of [...timers.values()]) callback(); }),
      focus: () => act(async () => { window.dispatchEvent(new Event("focus")); }),
      visibility: (state) => act(async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
        document.dispatchEvent(new Event("visibilitychange"));
      }),
      timerCount: () => timers.size,
    });
  } finally {
    await unmount();
    container.remove();
    fetch.mockRestore();
    endpoint.mockRestore();
    interval.mockRestore();
    clearInterval.mockRestore();
    await GlobalRegistrator.unregister();
  }
}

function expectOnlyStatusRequests(requests: BrowserRequest[]) {
  expect(requests.length).toBeGreaterThan(0);
  for (const { url, init } of requests) {
    expect(url).toContain("/v1/inference-providers/oauth/browser-status?attempt=entry.");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.credentials).toBe("include");
    expect(init?.cache).toBe("no-store");
    expect(init?.referrerPolicy).toBe("no-referrer");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
  }
}

test("signed-in browser skips OpenWork sign-in and shows only the Google decision", async () => {
  await fixture(async ({ container, button, requests, timerCount }) => {
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
    expect(button("Continue to Google").disabled).toBe(false);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
    expect(container.textContent).not.toContain("Technical details");
    expect(container.textContent).not.toContain("OpenWork account");
    expect(container.textContent).not.toContain("Google tokens");
    expect(container.textContent).not.toContain("cleanup revocation");
    expect(container.innerHTML).not.toContain("gradient");
    expect(container.querySelector("main")?.className).toContain("bg-[var(--dls-surface)]");
    expect(requests).toHaveLength(1);
    expectOnlyStatusRequests(requests);
    expect(timerCount()).toBe(0);
  });
});

test("signed-out browser shows only the primary OpenWork sign-in link", async () => {
  await fixture(async ({ container, requests }) => {
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to OpenWork");
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Sign in to OpenWork");
    expect(link?.getAttribute("href")).toBe("/");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toContain("Continue to Google");
    expect(container.querySelector("details")).toBeNull();
    expectOnlyStatusRequests(requests);
  }, { respond: () => Response.json({ status: "sign_in_required" }) });
});

test("mount waits for the runtime endpoint before checking the browser and preserves a loading skeleton", async () => {
  const config = deferred<string>();
  await fixture(async ({ container, requests }) => {
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Checking OpenWork sign-in");
    expect(container.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll("button, a")).toHaveLength(0);
    expect(requests).toHaveLength(0);
    await act(async () => config.resolve("https://api.den.example.test/v1/inference-providers/oauth/browser-status?attempt=entry.test"));
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
    expect(requests).toHaveLength(1);
    expect(requests[0].init?.credentials).toBe("include");
  }, { endpoint: () => config.promise });
});

test("returning focus advances to Google without consuming the attempt or navigating", async () => {
  let signedIn = false;
  await fixture(async ({ container, requests, focus, button, timerCount }) => {
    const navigate = spyOn(window.location, "assign");
    try {
      signedIn = true;
      await focus();
      expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
      expect(button("Continue to Google").disabled).toBe(false);
      expect(container.querySelector("a")).toBeNull();
      expect(requests).toHaveLength(2);
      expectOnlyStatusRequests(requests);
      expect(navigate).not.toHaveBeenCalled();
      expect(timerCount()).toBe(0);
    } finally { navigate.mockRestore(); }
  }, { respond: () => Response.json({ status: signedIn ? "ready" : "sign_in_required" }) });
});

test("visibility rechecks only on returning to the tab and readiness is never taken from local storage", async () => {
  let signedIn = false;
  await fixture(async ({ container, requests, visibility }) => {
    window.localStorage.setItem("gateway-ready", "true");
    await visibility("hidden");
    expect(requests).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to OpenWork");
    signedIn = true;
    await visibility("visible");
    expect(requests).toHaveLength(2);
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
    expectOnlyStatusRequests(requests);
  }, { respond: () => Response.json({ status: signedIn ? "ready" : "sign_in_required" }) });
});

test("waiting polls are read-only, bounded, and focus still rechecks after polling ends", async () => {
  await fixture(async ({ requests, poll, focus, timerCount }) => {
    for (let index = 0; index < 45; index += 1) await poll();
    expect(requests).toHaveLength(41);
    expect(timerCount()).toBe(0);
    await focus();
    expect(requests).toHaveLength(42);
    expectOnlyStatusRequests(requests);
  }, { respond: () => Response.json({ status: "sign_in_required" }) });
});

test("a waiting poll can reveal Google readiness but cannot start Google sign-in", async () => {
  let signedIn = false;
  await fixture(async ({ container, requests, poll, timerCount }) => {
    signedIn = true;
    await poll();
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
    expect(timerCount()).toBe(0);
    expect(requests).toHaveLength(2);
    expectOnlyStatusRequests(requests);
  }, { respond: () => Response.json({ status: signedIn ? "ready" : "sign_in_required" }) });
});

test("wrong-account recovery signs out then rechecks, without exposing the initiating identity", async () => {
  let signedOut = false;
  await fixture(async ({ container, button, requests }) => {
    expect(container.querySelector("h1")?.textContent).toBe("Switch OpenWork account");
    expect(container.querySelector('[data-notice-tone="neutral"]')?.textContent).toContain("Use the OpenWork account that started Connect.");
    expect(container.textContent).not.toContain("initiator@example.test");
    expect(container.textContent).not.toContain("Continue to Google");
    expect(container.querySelector("a")).toBeNull();
    await act(async () => button("Sign out of this browser account").click());
    expect(requests).toHaveLength(3);
    expect(requests[1].url).toBe("https://den.example.test/api/auth/sign-out");
    expect(requests[1].init?.method).toBe("POST");
    expect(requests[1].init?.credentials).toBe("include");
    expect(requests[2].url).toContain("/oauth/browser-status?");
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to OpenWork");
    expect(container.querySelector("a")?.textContent).toBe("Sign in to OpenWork");
    expect(container.querySelector("button")).toBeNull();
  }, { respond: ({ url }) => {
    if (url.endsWith("/api/auth/sign-out")) {
      signedOut = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ status: signedOut ? "sign_in_required" : "account_mismatch", message: "initiator@example.test" });
  } });
});

test("uncertain sign-out requires a safe recheck instead of assuming the browser is signed out", async () => {
  let signedOut = false;
  await fixture(async ({ container, button, requests }) => {
    await act(async () => button("Sign out of this browser account").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm sign-out");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("Continue to Google");
    await act(async () => button("Retry sign-in check").click());
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to OpenWork");
    expect(requests.filter(({ url }) => url.endsWith("/api/auth/sign-out"))).toHaveLength(1);
  }, { respond: ({ url }) => {
    if (url.endsWith("/api/auth/sign-out")) {
      signedOut = true;
      throw new Error("network_lost");
    }
    return Response.json({ status: signedOut ? "sign_in_required" : "account_mismatch" });
  } });
});

for (const entry of [
  { status: 400, error: "oauth_entry_expired", message: "This connection attempt expired. Start Connect again.", title: "Start Connect again" },
  { status: 403, error: "forbidden", message: "Your administrator must grant connection access.", title: "Connection unavailable" },
  { status: 403, error: "oauth_configuration_changed", message: "Provider configuration changed. Start Connect again.", title: "Connection unavailable" },
]) {
  test(`status ${entry.error} blocks Google with actionable inline recovery`, async () => {
    await fixture(async ({ container, requests }) => {
      expect(container.querySelector("h1")?.textContent).toBe(entry.title);
      expect(container.textContent).toContain(entry.message);
      expect(container.textContent).not.toContain("Continue to Google");
      expect(container.querySelector("a")).toBeNull();
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector('[data-notice-tone="neutral"]') !== null).toBe(entry.status === 403);
      expectOnlyStatusRequests(requests);
    }, { respond: () => Response.json({ error: entry.error, message: entry.message }, { status: entry.status }) });
  });
}

test("invalid browser attempts never reach either endpoint", async () => {
  await fixture(async ({ container, requests, focus }) => {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This connection link is invalid. Start Connect again in OpenWork.");
    expect(container.textContent).not.toContain("Continue to Google");
    await focus();
    expect(requests).toHaveLength(0);
  }, { attempt: "invalid", endpoint: async () => { throw new Error("Unexpected endpoint request"); } });
});

for (const failure of ["network", "invalid_json", "invalid_status", "server_error"]) {
  test(`${failure} cannot enable Google and can retry only the safe status check`, async () => {
    let fail = true;
    await fixture(async ({ container, requests, button, timerCount }) => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not verify your sign-in");
      expect(container.textContent).not.toContain("Continue to Google");
      expect(timerCount()).toBe(0);
      fail = false;
      await act(async () => button("Retry sign-in check").click());
      expect(button("Continue to Google").disabled).toBe(false);
      expectOnlyStatusRequests(requests);
    }, { respond: () => {
      if (!fail) return Response.json({ status: "ready" });
      if (failure === "network") throw new Error("offline");
      if (failure === "invalid_json") return new Response("not json");
      if (failure === "server_error") return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ status: "unknown" });
    } });
  });
}

test("a pending recheck disables previously ready Google continuation and ignores stale responses", async () => {
  const stale = deferred<Response>();
  const latest = deferred<Response>();
  let count = 0;
  await fixture(async ({ container, requests, focus, button }) => {
    await focus();
    expect(button("Continue to Google").disabled).toBe(true);
    await act(async () => button("Continue to Google").click());
    expect(requests).toHaveLength(2);
    await focus();
    expect(requests[1].init?.signal?.aborted).toBe(true);
    await act(async () => latest.resolve(Response.json({ status: "sign_in_required" })));
    await act(async () => stale.resolve(Response.json({ status: "ready" })));
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to OpenWork");
    expect(container.textContent).not.toContain("Continue to Google");
    expectOnlyStatusRequests(requests);
  }, { respond: () => {
    count += 1;
    return count === 1 ? Response.json({ status: "ready" }) : count === 2 ? stale.promise : latest.promise;
  } });
});

test("a stale rejected status request cannot overwrite a newer ready response", async () => {
  const stale = deferred<Response>();
  let count = 0;
  await fixture(async ({ container, requests, focus, button }) => {
    await focus();
    expect(requests[0].init?.signal?.aborted).toBe(true);
    await act(async () => stale.reject(new Error("late_network_failure")));
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
    expect(button("Continue to Google").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expectOnlyStatusRequests(requests);
  }, { respond: () => ++count === 1 ? stale.promise : Response.json({ status: "ready" }) });
});

test("stale endpoint resolution cannot issue a request after a newer focus check", async () => {
  const stale = deferred<string>();
  let count = 0;
  await fixture(async ({ container, requests, focus }) => {
    await focus();
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
    await act(async () => stale.resolve("https://den.example.test/stale"));
    expect(requests).toHaveLength(1);
    expectOnlyStatusRequests(requests);
  }, { endpoint: async (path) => ++count === 1 ? stale.promise : `https://den.example.test${path}` });
});

test("only an explicit Continue click consumes the attempt and rapid double clicks send once", async () => {
  const start = deferred<Response>();
  await fixture(async ({ button, requests, focus, poll }) => {
    const navigate = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      const continueButton = button("Continue to Google");
      await act(async () => { continueButton.click(); continueButton.click(); });
      expect(requests.filter(({ url }) => url.includes("/browser-start?"))).toHaveLength(1);
      expect(requests[1].init?.credentials).toBe("include");
      await focus();
      await poll();
      expect(requests).toHaveLength(2);
      await act(async () => start.resolve(Response.json({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test" })));
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=test");
      await act(async () => continueButton.click());
      expect(requests).toHaveLength(2);
    } finally { navigate.mockRestore(); }
  }, { respond: ({ url }) => url.includes("/browser-start?") ? start.promise : Response.json({ status: "ready" }) });
});

test("uncertain consuming result never automatically retries or becomes ready on focus", async () => {
  await fixture(async ({ container, button, requests, focus, visibility, poll }) => {
    await act(async () => button("Continue to Google").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm whether Google sign-in started. Start Connect again");
    await focus();
    await visibility("visible");
    await poll();
    expect(requests).toHaveLength(2);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  }, { respond: ({ url }) => {
    if (url.includes("/browser-start?")) throw new Error("lost_response");
    return Response.json({ status: "ready" });
  } });
});

test("a server-side account mismatch at Continue returns to account recovery", async () => {
  await fixture(async ({ container, button }) => {
    await act(async () => button("Continue to Google").click());
    expect(container.querySelector("h1")?.textContent).toBe("Switch OpenWork account");
    expect(button("Sign out of this browser account").disabled).toBe(false);
    expect(container.textContent).not.toContain("initiator@example.test");
  }, { respond: ({ url }) => url.includes("/browser-start?")
    ? Response.json({ error: "browser_account_mismatch", message: "initiator@example.test" }, { status: 403 })
    : Response.json({ status: "ready" }) });
});

test("an invalid Google authorization URL cannot navigate or retry the consuming request", async () => {
  await fixture(async ({ container, button, requests, focus }) => {
    const navigate = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await act(async () => button("Continue to Google").click());
      await focus();
      expect(navigate).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      expect(container.querySelector("h1")?.textContent).toBe("Start Connect again");
    } finally { navigate.mockRestore(); }
  }, { respond: ({ url }) => url.includes("/browser-start?")
    ? Response.json({ authUrl: "https://other.example.test/authorize" })
    : Response.json({ status: "ready" }) });
});

test("unmount aborts status requests and removes focus, visibility, and polling handlers", async () => {
  const pending = deferred<Response>();
  let count = 0;
  await fixture(async ({ requests, focus, visibility, poll, unmount, timerCount }) => {
    await focus();
    await unmount();
    expect(requests[1].init?.signal?.aborted).toBe(true);
    expect(timerCount()).toBe(0);
    await act(async () => pending.resolve(Response.json({ status: "ready" })));
    await focus();
    await visibility("visible");
    await poll();
    expect(requests).toHaveLength(2);
  }, { respond: () => ++count === 1 ? Response.json({ status: "sign_in_required" }) : pending.promise });
});

test("unmount during endpoint resolution prevents any status request", async () => {
  const pending = deferred<string>();
  await fixture(async ({ requests, unmount }) => {
    await unmount();
    await act(async () => pending.resolve("https://den.example.test/status"));
    expect(requests).toHaveLength(0);
  }, { endpoint: () => pending.promise });
});

test("unmount aborts a consuming request and a late response cannot navigate", async () => {
  const pending = deferred<Response>();
  await fixture(async ({ button, requests, unmount }) => {
    const navigate = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      await act(async () => button("Continue to Google").click());
      await unmount();
      expect(requests[1].init?.signal?.aborted).toBe(true);
      await act(async () => pending.resolve(Response.json({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test" })));
      expect(navigate).not.toHaveBeenCalled();
    } finally { navigate.mockRestore(); }
  }, { respond: ({ url }) => url.includes("/browser-start?") ? pending.promise : Response.json({ status: "ready" }) });
});

test("Strict Mode effect replay never consumes an attempt", async () => {
  await fixture(async ({ container, requests }) => {
    expect(container.querySelector("h1")?.textContent).toBe("Sign in to Google");
    expectOnlyStatusRequests(requests);
  }, { strict: true });
});
