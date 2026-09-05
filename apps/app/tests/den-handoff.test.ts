import { afterEach, describe, expect, test } from "bun:test";

import {
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  readDenSettings,
} from "../src/app/lib/den";
import { exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";
import {
  hasActiveDesktopSignInIntent,
  markDesktopSignInInitiated,
  markOrgSelectionPending,
  readOrgSelectionPending,
} from "../src/app/lib/den-sign-in-intent";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

type SessionEvent = {
  status?: string;
  message?: string | null;
  /** Bootstrap origin observed at the moment the event was published. */
  bootstrapBaseUrlAtDispatch: string;
};

type StubbedWindow = {
  sessionEvents: SessionEvent[];
};

function stubWindow(extra?: Record<string, unknown>): StubbedWindow {
  const sessionEvents: SessionEvent[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      dispatchEvent(event: Event) {
        if (event.type === "openwork-den-session-updated") {
          const detail = (event as CustomEvent<{ status?: string; message?: string | null }>).detail;
          sessionEvents.push({
            status: detail?.status,
            message: detail?.message ?? null,
            bootstrapBaseUrlAtDispatch: readDenBootstrapConfig().baseUrl,
          });
        }
        return true;
      },
      ...extra,
    },
  });
  return { sessionEvents };
}

type RecordedRequest = { url: string; method: string };

function stubFetch(
  handler: (url: URL) => { status: number; body?: unknown } | Promise<Response>,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url: raw, method: init?.method ?? "GET" });
      const outcome = handler(new URL(raw));
      if (outcome instanceof Promise) return outcome;
      return new Response(JSON.stringify(outcome.body ?? {}), {
        status: outcome.status,
        headers: { "Content-Type": "application/json" },
      });
    }) satisfies typeof fetch,
  });
  return requests;
}

function stubExchangeResponse(payload: Record<string, unknown>): RecordedRequest[] {
  return stubFetch(() => ({ status: 200, body: payload }));
}

const exchangeUser = { id: "user_invited", email: "invited@example.com", name: "Invited Member" };

function seedSignedInAt(baseUrl: string, token: string, org?: { id: string; slug: string; name: string }) {
  window.localStorage.setItem("openwork.den.baseUrl", baseUrl);
  window.localStorage.setItem("openwork.den.authToken", token);
  // Dev's origin-coherence invariant stores the issuing origin next to the
  // token (denOriginComparisonKey form; equal to the origin for these URLs).
  window.localStorage.setItem("openwork.den.sessionOrigin", baseUrl);
  if (org) {
    window.localStorage.setItem("openwork.den.activeOrgId", org.id);
    window.localStorage.setItem("openwork.den.activeOrgSlug", org.slug);
    window.localStorage.setItem("openwork.den.activeOrgName", org.name);
  }
}

afterEach(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  // Reset the module-level bootstrap snapshot mutated by committed handoffs.
  await initializeDenBootstrapConfig();
});

describe("exchangeHandoffAndSignIn", () => {
  test("persists the organization resolved by the handoff exchange", async () => {
    stubWindow();
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_invited", slug: "invited-org", name: "Invited Org" },
      connectEnabled: false,
    });

    const result = await exchangeHandoffAndSignIn("grant_test", { baseUrl: "https://den.test" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_invited");
    expect(window.localStorage.getItem("openwork.den.activeOrgSlug")).toBe("invited-org");
    expect(window.localStorage.getItem("openwork.den.activeOrgName")).toBe("Invited Org");
    expect(window.localStorage.getItem("openwork.den.sessionOrigin")).toBe("https://den.test");
    expect(result.exchange.connectEnabled).toBe(false);
    expect(window.localStorage.getItem("openwork.den.desktopConfig:https://den.test::org_invited"))
      .toBe(JSON.stringify({ connectEnabled: false }));
  });

  test("prefers the caller-provided organization over the exchange payload", async () => {
    stubWindow();
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_exchange", slug: "exchange-org", name: "Exchange Org" },
    });

    const result = await exchangeHandoffAndSignIn("grant_test", {
      baseUrl: "https://den.test",
      activeOrg: { id: "org_bootstrap", slug: "bootstrap-org", name: "Bootstrap Org" },
    });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_bootstrap");
    expect(window.localStorage.getItem("openwork.den.desktopConfig:https://den.test::org_bootstrap")).toBeNull();
  });

  test("a same-origin handoff without an exchange org preserves the stored organization", async () => {
    stubWindow();
    seedSignedInAt("https://den.test", "tok_before", {
      id: "org_stored",
      slug: "stored-org",
      name: "Stored Org",
    });
    stubExchangeResponse({ token: "tok_handoff", user: exchangeUser });

    const result = await exchangeHandoffAndSignIn("grant_test", { baseUrl: "https://den.test" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_stored");
    expect(window.localStorage.getItem("openwork.den.activeOrgSlug")).toBe("stored-org");
    expect(window.localStorage.getItem("openwork.den.activeOrgName")).toBe("Stored Org");
    expect(result.exchange.connectEnabled).toBeNull();
    expect(window.localStorage.getItem("openwork.den.desktopConfig:https://den.test::org_stored"))
      .toBeNull();
  });

  test("a cross-origin handoff without a destination org does not inherit the source organization", async () => {
    stubWindow();
    seedSignedInAt("https://den-a.test", "tok_a", { id: "org_a", slug: "org-a", name: "Org A" });
    stubExchangeResponse({ token: "tok_b", user: exchangeUser });

    const result = await exchangeHandoffAndSignIn("grant_b", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    // Origin, token, and enrollment marker all switched together…
    expect(window.localStorage.getItem("openwork.den.baseUrl")).toBe("https://den-b.test");
    expect(window.localStorage.getItem("openwork.den.authToken")).toBe("tok_b");
    expect(window.localStorage.getItem("openwork.den.sessionOrigin")).toBe("https://den-b.test");
    // …and A's organization did not leak into B.
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBeNull();
    expect(window.localStorage.getItem("openwork.den.activeOrgSlug")).toBeNull();
    expect(window.localStorage.getItem("openwork.den.activeOrgName")).toBeNull();
  });

  test("a cross-origin handoff commits origin, token, and organization together", async () => {
    stubWindow();
    seedSignedInAt("https://den-a.test", "tok_a", { id: "org_a", slug: "org-a", name: "Org A" });
    const requests = stubExchangeResponse({
      token: "tok_b",
      user: exchangeUser,
      organization: { id: "org_b", slug: "org-b", name: "Org B" },
    });

    const result = await exchangeHandoffAndSignIn("grant_b", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("openwork.den.baseUrl")).toBe("https://den-b.test");
    expect(window.localStorage.getItem("openwork.den.authToken")).toBe("tok_b");
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_b");
    expect(window.localStorage.getItem("openwork.den.sessionOrigin")).toBe("https://den-b.test");
    // The grant went to the destination origin only — never to A. A
    // non-hosted destination has no derivable API sibling, so the exchange
    // stays on the destination's own same-origin API proxy.
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(new URL(request.url).hostname).toBe("den-b.test");
    }
  });

  test("a desktop-initiated sign-in defers the org choice to the chooser", async () => {
    stubWindow();
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_default", slug: "default-org", name: "Default Org" },
    });

    const result = await exchangeHandoffAndSignIn("grant_test", {
      baseUrl: "https://den.test",
      desktopInitiated: true,
    });

    expect(result.ok).toBe(true);
    // Token persists, but no organization is committed…
    expect(window.localStorage.getItem("openwork.den.authToken")).toBe("tok_handoff");
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBeNull();
    // …and the chooser sees the pending state with the exchange org suggested.
    expect(readOrgSelectionPending()).toEqual({
      pending: true,
      suggestion: { id: "org_default", slug: "default-org", name: "Default Org" },
    });
  });

  test("the desktop sign-in intent marker classifies an unlabeled handoff", async () => {
    stubWindow();
    markDesktopSignInInitiated();
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_default", slug: "default-org", name: "Default Org" },
    });

    const result = await exchangeHandoffAndSignIn("grant_test", { baseUrl: "https://den.test" });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBeNull();
    expect(readOrgSelectionPending().pending).toBe(true);
    // The marker is consumed: a later remote handoff is not reclassified.
    expect(hasActiveDesktopSignInIntent()).toBe(false);
  });

  test("an explicitly scoped org connects straight through even when desktop-initiated", async () => {
    stubWindow();
    markDesktopSignInInitiated();
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_exchange", slug: "exchange-org", name: "Exchange Org" },
    });

    const result = await exchangeHandoffAndSignIn("grant_test", {
      baseUrl: "https://den.test",
      activeOrg: { id: "org_invite", slug: "invite-org", name: "Invite Org" },
      desktopInitiated: true,
    });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_invite");
    expect(readOrgSelectionPending().pending).toBe(false);
  });

  test("a remote handoff clears stale pending state and commits its organization", async () => {
    stubWindow();
    markOrgSelectionPending({ id: "org_stale", slug: null, name: null });
    stubExchangeResponse({
      token: "tok_handoff",
      user: exchangeUser,
      organization: { id: "org_remote", slug: "remote-org", name: "Remote Org" },
    });

    const result = await exchangeHandoffAndSignIn("grant_test", {
      baseUrl: "https://den.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_remote");
    expect(readOrgSelectionPending()).toEqual({ pending: false, suggestion: null });
  });

  test("an exchange failure leaves the previous enrollment untouched and publishes no success", async () => {
    const { sessionEvents } = stubWindow();
    seedSignedInAt("https://den-a.test", "tok_a", { id: "org_a", slug: "org-a", name: "Org A" });
    stubFetch(() => ({ status: 500, body: { message: "exchange exploded" } }));

    const result = await exchangeHandoffAndSignIn("grant_b", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.grantConsumed).toBe(false);
    expect(window.localStorage.getItem("openwork.den.baseUrl")).toBe("https://den-a.test");
    expect(window.localStorage.getItem("openwork.den.authToken")).toBe("tok_a");
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_a");
    expect(window.localStorage.getItem("openwork.den.sessionOrigin")).toBe("https://den-a.test");
    expect(window.sessionStorage.getItem("openwork.den.handoffAutoContinueAt")).toBeNull();
    expect(sessionEvents.map((event) => event.status)).toEqual(["error"]);
  });

  test("the exchange client is constructed from the expected destination, not the caller", async () => {
    stubWindow();
    seedSignedInAt("https://den-a.test", "tok_a", { id: "org_a", slug: "org-a", name: "Org A" });
    const requests = stubExchangeResponse({ token: "tok_b", user: exchangeUser });

    const result = await exchangeHandoffAndSignIn("grant_b", {
      baseUrl: "https://den-b.test/",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    // Every request of the transaction targeted the normalized destination.
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(new URL(request.url).hostname).toBe("den-b.test");
    }
    expect(window.localStorage.getItem("openwork.den.baseUrl")).toBe("https://den-b.test");
  });

  test("a late result from an older handoff attempt cannot replace a newer enrollment", async () => {
    stubWindow();
    seedSignedInAt("https://den-a.test", "tok_a", { id: "org_a", slug: "org-a", name: "Org A" });

    let resolveOld: ((response: Response) => void) | null = null;
    stubFetch((url) => {
      if (url.hostname === "den-old.test") {
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      }
      return {
        status: 200,
        body: {
          token: "tok_new",
          user: exchangeUser,
          organization: { id: "org_new", slug: "org-new", name: "Org New" },
        },
      };
    });

    const oldAttempt = exchangeHandoffAndSignIn("grant_old", {
      baseUrl: "https://den-old.test",
      desktopInitiated: false,
    });
    // The old attempt's exchange must be in flight before the new one starts.
    while (!resolveOld) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const newAttempt = await exchangeHandoffAndSignIn("grant_new", {
      baseUrl: "https://den-new.test",
      desktopInitiated: false,
    });
    expect(newAttempt.ok).toBe(true);

    resolveOld(new Response(
      JSON.stringify({
        token: "tok_old",
        user: exchangeUser,
        organization: { id: "org_old", slug: "org-old", name: "Org Old" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const oldResult = await oldAttempt;

    expect(oldResult.ok).toBe(false);
    if (oldResult.ok) throw new Error("expected stale failure");
    expect(oldResult.stale).toBe(true);
    // The newer enrollment stands, complete and unmixed.
    expect(window.localStorage.getItem("openwork.den.baseUrl")).toBe("https://den-new.test");
    expect(window.localStorage.getItem("openwork.den.authToken")).toBe("tok_new");
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_new");
    expect(window.localStorage.getItem("openwork.den.sessionOrigin")).toBe("https://den-new.test");
  });

  test("concurrent handoffs to two destinations cannot cross origins, tokens, or organizations", async () => {
    stubWindow();
    seedSignedInAt("https://den-a.test", "tok_a", { id: "org_a", slug: "org-a", name: "Org A" });

    const resolvers = new Map<string, (response: Response) => void>();
    stubFetch((url) => new Promise<Response>((resolve) => {
      resolvers.set(url.hostname, resolve);
    }));

    const attemptB = exchangeHandoffAndSignIn("grant_b", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });
    const attemptC = exchangeHandoffAndSignIn("grant_c", {
      baseUrl: "https://den-c.test",
      desktopInitiated: false,
    });

    // Both exchanges must be in flight before either destination responds.
    while (resolvers.size < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const respond = (host: string, token: string, org: string) => {
      resolvers.get(host)?.(new Response(
        JSON.stringify({
          token,
          user: exchangeUser,
          organization: { id: org, slug: org, name: org },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    };
    // B's exchange returns first, then C's — the newest attempt still wins.
    respond("den-b.test", "tok_b", "org_b");
    respond("den-c.test", "tok_c", "org_c");

    const [resultB, resultC] = await Promise.all([attemptB, attemptC]);

    expect(resultC.ok).toBe(true);
    expect(resultB.ok).toBe(false);
    if (resultB.ok) throw new Error("expected the superseded attempt to fail");
    expect(resultB.stale).toBe(true);

    // Every persisted field belongs to C — no mixing with B or A.
    expect(window.localStorage.getItem("openwork.den.baseUrl")).toBe("https://den-c.test");
    expect(window.localStorage.getItem("openwork.den.authToken")).toBe("tok_c");
    expect(window.localStorage.getItem("openwork.den.activeOrgId")).toBe("org_c");
    expect(window.localStorage.getItem("openwork.den.sessionOrigin")).toBe("https://den-c.test");
  });
});

describe("exchangeHandoffAndSignIn on desktop (durable bootstrap commit)", () => {
  type BootstrapFile = Record<string, unknown>;

  function stubDesktopWindow(input: {
    bootstrap: BootstrapFile;
    failBootstrapWrites?: boolean;
    /** Optional runtime-config payload served by the destination web origin. */
    runtimeConfig?: Record<string, unknown>;
    exchange: (url: URL) => { status: number; body?: unknown };
  }) {
    const state = {
      bootstrapFile: { ...input.bootstrap },
      bootstrapWrites: 0,
      requests: [] as RecordedRequest[],
      failBootstrapWrites: input.failBootstrapWrites === true,
    };
    const stubbed = stubWindow({
      location: { origin: "http://localhost:5173" },
      __OPENWORK_ELECTRON__: {
        meta: { desktopBootstrap: { ...input.bootstrap } },
        invokeDesktop: async (command: string, ...args: unknown[]) => {
          if (command === "getDesktopBootstrapConfig") {
            return { ...state.bootstrapFile };
          }
          if (command === "setDesktopBootstrapConfig") {
            if (state.failBootstrapWrites) {
              throw new Error("bootstrap write failed: disk unavailable");
            }
            state.bootstrapWrites += 1;
            state.bootstrapFile = { ...(args[0] as BootstrapFile), fromFile: true };
            return { ...state.bootstrapFile };
          }
          if (command === "__fetch") {
            const url = new URL(args[0] as string);
            state.requests.push({
              url: url.toString(),
              method: ((args[1] as { method?: string } | undefined)?.method) ?? "GET",
            });
            if (url.pathname === "/api/runtime-config") {
              if (input.runtimeConfig) {
                return {
                  status: 200,
                  statusText: "",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(input.runtimeConfig),
                };
              }
              return { status: 404, statusText: "Not Found", headers: {}, body: "" };
            }
            const outcome = input.exchange(url);
            return {
              status: outcome.status,
              statusText: "",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(outcome.body ?? {}),
            };
          }
          throw new Error(`unexpected desktop command: ${command}`);
        },
      },
    });
    return { state, sessionEvents: stubbed.sessionEvents };
  }

  test("a bootstrap persistence failure leaves the complete previous enrollment active", async () => {
    const logs: string[] = [];
    const originalConsole = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const { state, sessionEvents } = stubDesktopWindow({
        bootstrap: { baseUrl: "https://den-a.test", requireSignin: false, fromFile: true },
        failBootstrapWrites: true,
        exchange: () => ({
          status: 200,
          body: {
            token: "tok_b_secret",
            user: exchangeUser,
            organization: { id: "org_b", slug: "org-b", name: "Org B" },
          },
        }),
      });
      await initializeDenBootstrapConfig();
      window.localStorage.setItem("openwork.den.authToken", "tok_a");
      window.localStorage.setItem("openwork.den.sessionOrigin", "https://den-a.test");
      window.localStorage.setItem("openwork.den.activeOrgId", "org_a");
      window.localStorage.setItem("openwork.den.activeOrgSlug", "org-a");
      window.localStorage.setItem("openwork.den.activeOrgName", "Org A");

      const result = await exchangeHandoffAndSignIn("grant_b_secret", {
        baseUrl: "https://den-b.test",
        desktopInitiated: false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      // The one-time grant is spent; callers must not retry it blindly.
      expect(result.grantConsumed).toBe(true);

      // The complete A enrollment is still active: origin, token, and org.
      expect(readDenBootstrapConfig().baseUrl).toBe("https://den-a.test");
      expect(state.bootstrapFile.baseUrl).toBe("https://den-a.test");
      const settings = readDenSettings();
      expect(settings.baseUrl).toBe("https://den-a.test");
      expect(settings.authToken).toBe("tok_a");
      expect(settings.activeOrgId).toBe("org_a");
      // No B credential became visible and no B success state was published.
      expect(window.localStorage.getItem("openwork.den.authToken")).toBe("tok_a");
      expect(window.sessionStorage.getItem("openwork.den.handoffAutoContinueAt")).toBeNull();
      expect(sessionEvents.map((event) => event.status)).toEqual(["error"]);
      // The exchange spoke only to B — the failed handoff sent nothing to A.
      // (Runtime-config probes are credential-free GETs and are excluded.)
      const exchangeRequests = state.requests.filter(
        (request) => new URL(request.url).pathname !== "/api/runtime-config",
      );
      expect(exchangeRequests.length).toBeGreaterThan(0);
      for (const request of exchangeRequests) {
        expect(new URL(request.url).hostname.endsWith("den-b.test")).toBe(true);
        expect(request.url).toContain("/v1/auth/desktop-handoff/exchange");
      }
      // Diagnostics never contain the grant or the tokens.
      const captured = logs.join("\n");
      expect(captured).not.toContain("grant_b_secret");
      expect(captured).not.toContain("tok_b_secret");
      expect(captured).not.toContain("tok_a");
    } finally {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    }
  });

  test("a committed bootstrap that is not the expected destination is rejected and rolled back", async () => {
    const { state, sessionEvents } = stubDesktopWindow({
      bootstrap: { baseUrl: "https://den-a.test", requireSignin: false, fromFile: true },
      exchange: () => ({
        status: 200,
        body: {
          token: "tok_b",
          user: exchangeUser,
          organization: { id: "org_b", slug: "org-b", name: "Org B" },
        },
      }),
    });
    await initializeDenBootstrapConfig();
    window.localStorage.setItem("openwork.den.authToken", "tok_a");
    window.localStorage.setItem("openwork.den.sessionOrigin", "https://den-a.test");
    window.localStorage.setItem("openwork.den.activeOrgId", "org_a");

    // The shell "persists" a different origin than the transaction asked for
    // (a tampered or corrupted write). The first divergent write is detected;
    // the rollback write is allowed through so the previous state is restored.
    const bridge = window.__OPENWORK_ELECTRON__ as unknown as {
      invokeDesktop: (command: string, ...args: unknown[]) => Promise<unknown>;
    };
    const originalInvoke = bridge.invokeDesktop;
    let divergedOnce = false;
    bridge.invokeDesktop = async (command: string, ...args: unknown[]) => {
      if (command === "setDesktopBootstrapConfig" && !divergedOnce) {
        divergedOnce = true;
        return originalInvoke(command, {
          ...(args[0] as Record<string, unknown>),
          baseUrl: "https://den-evil.test",
        });
      }
      return originalInvoke(command, ...args);
    };

    const result = await exchangeHandoffAndSignIn("grant_b", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.grantConsumed).toBe(true);
    // The rollback restored the previous origin durably…
    expect(state.bootstrapFile.baseUrl).toBe("https://den-a.test");
    expect(readDenBootstrapConfig().baseUrl).toBe("https://den-a.test");
    // …the previous enrollment stayed active, and no B state was published.
    const settings = readDenSettings();
    expect(settings.authToken).toBe("tok_a");
    expect(settings.activeOrgId).toBe("org_a");
    expect(sessionEvents.map((event) => event.status)).toEqual(["error"]);
  });

  test("a successful cross-server handoff commits the bootstrap durably before publishing success", async () => {
    const { state, sessionEvents } = stubDesktopWindow({
      bootstrap: { baseUrl: "https://den-a.test", requireSignin: false, fromFile: true },
      exchange: () => ({
        status: 200,
        body: {
          token: "tok_b",
          user: exchangeUser,
          organization: { id: "org_b", slug: "org-b", name: "Org B" },
        },
      }),
    });
    await initializeDenBootstrapConfig();
    window.localStorage.setItem("openwork.den.authToken", "tok_a");
    window.localStorage.setItem("openwork.den.sessionOrigin", "https://den-a.test");
    window.localStorage.setItem("openwork.den.activeOrgId", "org_a");

    const result = await exchangeHandoffAndSignIn("grant_b", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    // Durably persisted destination…
    expect(state.bootstrapWrites).toBe(1);
    expect(state.bootstrapFile.baseUrl).toBe("https://den-b.test");
    // …and the success event observed the committed bootstrap, proving the
    // durable commit happened before publication.
    expect(sessionEvents.map((event) => event.status)).toEqual(["success"]);
    expect(sessionEvents[0]?.bootstrapBaseUrlAtDispatch).toBe("https://den-b.test");
    const settings = readDenSettings();
    expect(settings.baseUrl).toBe("https://den-b.test");
    expect(settings.authToken).toBe("tok_b");
    expect(settings.activeOrgId).toBe("org_b");
    expect(window.localStorage.getItem("openwork.den.sessionOrigin")).toBe("https://den-b.test");
  });

  test("a session enrolled against another origin is never exposed to the active control plane", async () => {
    // Simulates a restart after an interrupted commit: the durable bootstrap
    // points at B while the stored session still belongs to A.
    stubDesktopWindow({
      bootstrap: { baseUrl: "https://den-b.test", requireSignin: false, fromFile: true },
      exchange: () => ({ status: 500 }),
    });
    await initializeDenBootstrapConfig();
    window.localStorage.setItem("openwork.den.authToken", "tok_a");
    window.localStorage.setItem("openwork.den.sessionOrigin", "https://den-a.test");
    window.localStorage.setItem("openwork.den.activeOrgId", "org_a");

    const settings = readDenSettings();
    // Never a hybrid: at B, A's credential and organization are absent.
    expect(settings.baseUrl).toBe("https://den-b.test");
    expect(settings.authToken).toBeNull();
    expect(settings.activeOrgId).toBeNull();
  });

  test("a restart after a committed handoff restores the complete new enrollment", async () => {
    stubDesktopWindow({
      bootstrap: { baseUrl: "https://den-b.test", requireSignin: false, fromFile: true },
      exchange: () => ({ status: 500 }),
    });
    await initializeDenBootstrapConfig();
    window.localStorage.setItem("openwork.den.authToken", "tok_b");
    window.localStorage.setItem("openwork.den.sessionOrigin", "https://den-b.test");
    window.localStorage.setItem("openwork.den.activeOrgId", "org_b");

    const settings = readDenSettings();
    expect(settings.baseUrl).toBe("https://den-b.test");
    expect(settings.authToken).toBe("tok_b");
    expect(settings.activeOrgId).toBe("org_b");
  });

  test("a runtime-published API origin with no verified relationship never receives the grant", async () => {
    const { state } = stubDesktopWindow({
      bootstrap: { baseUrl: "https://den-a.test", requireSignin: false, fromFile: true },
      // The destination's runtime config points the API at an unrelated host.
      // A syntactically valid URL is not authority: the one-time grant and
      // the resulting bearer credential must never be routed there.
      runtimeConfig: { denApiUrl: "https://collector.attacker.test" },
      exchange: () => ({
        status: 200,
        body: { token: "tok_b_secret", user: exchangeUser, organization: { id: "org_b", slug: "org-b", name: "Org B" } },
      }),
    });
    await initializeDenBootstrapConfig();

    const result = await exchangeHandoffAndSignIn("grant_b_secret", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    // The one-time grant never left the destination's own origin: no request
    // of any kind reached the unverified published origin during the
    // handoff transaction.
    for (const request of state.requests) {
      expect(new URL(request.url).hostname).not.toBe("collector.attacker.test");
    }
    // The exchange stayed on the destination's own same-origin API proxy.
    const exchangeRequests = state.requests.filter((request) =>
      request.url.includes("/v1/auth/desktop-handoff/exchange"),
    );
    expect(exchangeRequests.length).toBeGreaterThan(0);
    for (const request of exchangeRequests) {
      expect(new URL(request.url).hostname).toBe("den-b.test");
    }
    expect(readDenSettings().authToken).toBe("tok_b_secret");
  });

  test("a runtime-published same-origin API base is still adopted", async () => {
    const { state } = stubDesktopWindow({
      bootstrap: { baseUrl: "https://den-a.test", requireSignin: false, fromFile: true },
      runtimeConfig: { denApiUrl: "https://den-b.test" },
      exchange: () => ({
        status: 200,
        body: { token: "tok_b_secret", user: exchangeUser, organization: { id: "org_b", slug: "org-b", name: "Org B" } },
      }),
    });
    await initializeDenBootstrapConfig();

    const result = await exchangeHandoffAndSignIn("grant_b_secret", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    const exchangeRequests = state.requests.filter((request) =>
      request.url.includes("/v1/auth/desktop-handoff/exchange"),
    );
    expect(exchangeRequests.length).toBeGreaterThan(0);
    for (const request of exchangeRequests) {
      expect(new URL(request.url).hostname).toBe("den-b.test");
    }
  });

  test("a cross-origin handoff clears the previous origin's enterprise activation stamp", async () => {
    const { state } = stubDesktopWindow({
      bootstrap: {
        baseUrl: "https://den-a.test",
        requireSignin: false,
        requireActivation: true,
        enterpriseActivation: { activatedAt: "2026-01-01T00:00:00.000Z", denBaseUrl: "https://den-a.test" },
        fromFile: true,
      },
      exchange: () => ({
        status: 200,
        body: { token: "tok_b_secret", user: exchangeUser, organization: { id: "org_b", slug: "org-b", name: "Org B" } },
      }),
    });
    await initializeDenBootstrapConfig();

    const result = await exchangeHandoffAndSignIn("grant_b_secret", {
      baseUrl: "https://den-b.test",
      desktopInitiated: false,
    });

    expect(result.ok).toBe(true);
    // The committed B bootstrap must not inherit A's activation stamp:
    // an inherited stamp would mark the new control plane as already
    // activated and bypass its activation gate.
    expect(state.bootstrapFile.baseUrl).toBe("https://den-b.test");
    expect(state.bootstrapFile.enterpriseActivation).toBeUndefined();
    expect(readDenBootstrapConfig().enterpriseActivation ?? null).toBeNull();
  });

  test("a same-origin recommit preserves the origin's own enterprise activation stamp", async () => {
    const stamp = { activatedAt: "2026-01-01T00:00:00.000Z", denBaseUrl: "https://den-a.test" };
    const { state } = stubDesktopWindow({
      bootstrap: {
        baseUrl: "https://den-a.test",
        requireSignin: false,
        enterpriseActivation: stamp,
        fromFile: true,
      },
      exchange: () => ({
        status: 200,
        body: { token: "tok_a_next", user: exchangeUser, organization: { id: "org_a", slug: "org-a", name: "Org A" } },
      }),
    });
    await initializeDenBootstrapConfig();

    const result = await exchangeHandoffAndSignIn("grant_a_refresh", {
      baseUrl: "https://den-a.test",
      desktopInitiated: false,
      // Force a bootstrap commit on the same origin.
      bootstrap: { requireSignin: false },
    });

    expect(result.ok).toBe(true);
    expect(state.bootstrapFile.baseUrl).toBe("https://den-a.test");
    expect(state.bootstrapFile.enterpriseActivation).toEqual(stamp);
  });
});
