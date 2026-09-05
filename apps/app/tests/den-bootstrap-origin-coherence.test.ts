import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearDenSession,
  ensureDenActiveOrganization,
  getDenBootstrapResolution,
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
  STORAGE_SESSION_ORIGIN,
  writeDenSettings,
} from "../src/app/lib/den";

const RETAINED_TOKEN = "retained-self-hosted-token-8fd1";
const RETAINED_ORG_ID = "org_selfhosted_1";

type WitnessRequest = {
  method: string;
  path: string;
  authorization: string | null;
};

type Witness = {
  url: string;
  origin: string;
  requests: WitnessRequest[];
  credentialed: () => WitnessRequest[];
  stop: () => void;
};

/** A deterministic Den control-plane stand-in that records every request it sees. */
function startWitness(): Witness {
  const requests: WitnessRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
      });
      if (url.pathname === "/api/runtime-config") {
        return new Response("not found", { status: 404 });
      }
      if (url.pathname === "/v1/me/orgs") {
        return Response.json({
          orgs: [{ id: RETAINED_ORG_ID, name: "Self Hosted", slug: "self-hosted", role: "admin" }],
          activeOrgId: RETAINED_ORG_ID,
        });
      }
      if (url.pathname === "/v1/me/active-organization") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    origin: `http://localhost:${server.port}`,
    requests,
    credentialed: () => requests.filter((entry) => entry.authorization !== null),
    stop: () => server.stop(true),
  };
}

type FetchLogEntry = { url: string; authorization: string | null };

type ShellScript = {
  /** Sequential outcomes for getDesktopBootstrapConfig reads. The last entry repeats. */
  reads: Array<
    | { kind: "fail" }
    | { kind: "config"; config: Record<string, unknown> }
    | { kind: "defer"; promise: Promise<Record<string, unknown>> }
  >;
};

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

const originalWindow = globalThis.window;
const originalWarn = console.warn;
const originalError = console.error;

describe("den bootstrap and retained session origin coherence", () => {
  let fetchLog: FetchLogEntry[];
  let shellWrites: Array<Record<string, unknown>>;
  let consoleLines: string[];
  let witnesses: Witness[];

  function isLoopback(url: URL): boolean {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  }

  function installWindow(options: {
    shell: ShellScript;
    preloadBootstrap?: Record<string, unknown> | null;
    storage?: Storage;
  }): Storage {
    const storage = options.storage ?? memoryStorage();
    let readIndex = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        dispatchEvent: () => true,
        __OPENWORK_ELECTRON__: {
          ...(options.preloadBootstrap !== undefined
            ? { meta: { desktopBootstrap: options.preloadBootstrap } }
            : {}),
          invokeDesktop: async (command: string, ...args: unknown[]) => {
            if (command === "getDesktopBootstrapConfig") {
              const step = options.shell.reads[Math.min(readIndex, options.shell.reads.length - 1)];
              readIndex += 1;
              if (!step || step.kind === "fail") {
                throw new Error("shell bridge unavailable");
              }
              if (step.kind === "defer") return step.promise;
              return step.config;
            }
            if (command === "setDesktopBootstrapConfig") {
              const payload = args[0] as Record<string, unknown>;
              shellWrites.push(payload);
              return { ...payload, writtenAt: "2026-08-24T00:00:00.000Z" };
            }
            if (command === "__fetch") {
              const url = String(args[0]);
              const init = (args[1] ?? {}) as {
                method?: string;
                headers?: Record<string, string>;
                body?: string;
              };
              const headers = init.headers ?? {};
              const authorization = headers.Authorization ?? headers.authorization ?? null;
              fetchLog.push({ url, authorization });
              const parsed = new URL(url);
              if (isLoopback(parsed)) {
                const response = await fetch(url, {
                  method: init.method ?? "GET",
                  headers,
                  body: init.body,
                });
                return {
                  status: response.status,
                  statusText: response.statusText,
                  headers: Array.from(response.headers.entries()),
                  body: await response.text(),
                };
              }
              // Non-loopback origins (e.g. the hosted default) are recorded but
              // never reached: the test asserts what would have left the machine.
              return {
                status: 503,
                statusText: "Service Unavailable",
                headers: [["content-type", "application/json"]],
                body: "{}",
              };
            }
            throw new Error(`Unexpected desktop command: ${command}`);
          },
        },
      },
    });
    return storage;
  }

  function seedRetainedSession(storage: Storage, sessionOrigin: string | null) {
    storage.setItem("openwork.den.authToken", RETAINED_TOKEN);
    storage.setItem("openwork.den.activeOrgId", RETAINED_ORG_ID);
    storage.setItem("openwork.den.activeOrgSlug", "self-hosted");
    storage.setItem("openwork.den.activeOrgName", "Self Hosted");
    if (sessionOrigin) {
      storage.setItem(STORAGE_SESSION_ORIGIN, sessionOrigin);
    }
  }

  function credentialedFetches(): FetchLogEntry[] {
    return fetchLog.filter((entry) => entry.authorization !== null);
  }

  beforeEach(() => {
    fetchLog = [];
    shellWrites = [];
    consoleLines = [];
    witnesses = [];
    console.warn = (...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
    for (const witness of witnesses) witness.stop();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("a valid preload bootstrap resolves immediately and the matching session works", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({
      shell: { reads: [{ kind: "fail" }] },
      preloadBootstrap: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false, fromFile: true },
    });
    seedRetainedSession(storage, den.origin);

    await initializeDenBootstrapConfig();

    expect(getDenBootstrapResolution()).toBe("resolved");
    const settings = readDenSettings();
    expect(settings.authToken).toBe(RETAINED_TOKEN);
    expect(settings.activeOrgId).toBe(RETAINED_ORG_ID);

    const org = await ensureDenActiveOrganization();
    expect(org?.id).toBe(RETAINED_ORG_ID);
    const credentialed = den.credentialed();
    expect(credentialed.length).toBeGreaterThan(0);
    expect(credentialed.every((entry) => entry.authorization === `Bearer ${RETAINED_TOKEN}`)).toBe(true);
  });

  test("a retained session with an unresolved bootstrap issues zero credential-bearing requests", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({ shell: { reads: [{ kind: "fail" }] } });
    seedRetainedSession(storage, den.origin);

    await initializeDenBootstrapConfig();

    expect(getDenBootstrapResolution()).toBe("unresolved");
    const settings = readDenSettings();
    expect(settings.authToken).toBeNull();
    expect(settings.activeOrgId).toBeNull();

    // The credential-bearing helper the app uses on boot finds no usable session.
    expect(await ensureDenActiveOrganization()).toBeNull();
    expect(credentialedFetches()).toEqual([]);
    expect(den.credentialed()).toEqual([]);

    // The retained session survives quarantine instead of being destroyed.
    expect(storage.getItem("openwork.den.authToken")).toBe(RETAINED_TOKEN);
    expect(storage.getItem("openwork.den.activeOrgId")).toBe(RETAINED_ORG_ID);
  });

  test("a legacy untagged session is also quarantined while the bootstrap is unresolved", async () => {
    const storage = installWindow({ shell: { reads: [{ kind: "fail" }] } });
    seedRetainedSession(storage, null);

    await initializeDenBootstrapConfig();

    expect(getDenBootstrapResolution()).toBe("unresolved");
    expect(readDenSettings().authToken).toBeNull();
    expect(await ensureDenActiveOrganization()).toBeNull();
    expect(credentialedFetches()).toEqual([]);
  });

  test("the unresolved fallback is never persisted as an authoritative hosted selection", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({ shell: { reads: [{ kind: "fail" }] } });
    seedRetainedSession(storage, den.origin);

    await initializeDenBootstrapConfig();
    expect(getDenBootstrapResolution()).toBe("unresolved");
    expect(readDenBootstrapConfig().source).toBe("default");

    // A passive settings mirror of the (gated) state must not delete the
    // quarantined session and must not persist the fallback hosted URL.
    const gated = readDenSettings();
    writeDenSettings({ ...gated, authToken: null, activeOrgId: null, activeOrgSlug: null, activeOrgName: null });

    expect(shellWrites).toEqual([]);
    expect(storage.getItem("openwork.den.baseUrl")).toBeNull();
    expect(storage.getItem("openwork.den.authToken")).toBe(RETAINED_TOKEN);
    expect(storage.getItem("openwork.den.activeOrgId")).toBe(RETAINED_ORG_ID);
    expect(storage.getItem(STORAGE_SESSION_ORIGIN)).toBe(den.origin);
  });

  test("delayed resolution of the same self-hosted bootstrap re-enables the matching session", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({
      shell: {
        reads: [
          { kind: "fail" },
          { kind: "fail" },
          { kind: "config", config: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false, fromFile: true } },
        ],
      },
    });
    seedRetainedSession(storage, den.origin);

    await initializeDenBootstrapConfig();

    expect(getDenBootstrapResolution()).toBe("resolved");
    expect(readDenBootstrapConfig().baseUrl).toBe(den.url);
    const settings = readDenSettings();
    expect(settings.authToken).toBe(RETAINED_TOKEN);
    expect(settings.activeOrgId).toBe(RETAINED_ORG_ID);

    const org = await ensureDenActiveOrganization();
    expect(org?.id).toBe(RETAINED_ORG_ID);
    expect(den.credentialed().length).toBeGreaterThan(0);
  }, 10_000);

  test("background healing after the quick attempts also restores the session for the proven origin", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({
      shell: {
        reads: [
          { kind: "fail" },
          { kind: "fail" },
          { kind: "fail" },
          { kind: "config", config: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false, fromFile: true } },
        ],
      },
    });
    seedRetainedSession(storage, den.origin);

    await initializeDenBootstrapConfig();
    expect(getDenBootstrapResolution()).toBe("unresolved");
    expect(readDenSettings().authToken).toBeNull();

    const deadline = Date.now() + 8_000;
    while (getDenBootstrapResolution() !== "resolved" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(getDenBootstrapResolution()).toBe("resolved");
    expect(readDenBootstrapConfig().baseUrl).toBe(den.url);
    expect(readDenSettings().authToken).toBe(RETAINED_TOKEN);
  }, 15_000);

  test("resolution to a different origin quarantines the retained token and organization", async () => {
    const originalDen = startWitness();
    const otherDen = startWitness();
    witnesses.push(originalDen, otherDen);
    const storage = installWindow({
      shell: {
        reads: [
          { kind: "config", config: { baseUrl: otherDen.url, apiBaseUrl: otherDen.url, requireSignin: false, fromFile: true } },
        ],
      },
    });
    seedRetainedSession(storage, originalDen.origin);

    await initializeDenBootstrapConfig();

    expect(getDenBootstrapResolution()).toBe("resolved");
    const settings = readDenSettings();
    expect(settings.baseUrl).toBe(otherDen.url);
    expect(settings.authToken).toBeNull();
    expect(settings.activeOrgId).toBeNull();

    expect(await ensureDenActiveOrganization()).toBeNull();
    expect(otherDen.credentialed()).toEqual([]);
    expect(originalDen.credentialed()).toEqual([]);
    expect(credentialedFetches()).toEqual([]);

    // Quarantined, not destroyed: the session revives if its own origin returns.
    expect(storage.getItem("openwork.den.authToken")).toBe(RETAINED_TOKEN);
    expect(storage.getItem(STORAGE_SESSION_ORIGIN)).toBe(originalDen.origin);
  });

  test("a late bootstrap result from an obsolete startup generation cannot replace the current one", async () => {
    const staleDen = startWitness();
    const currentDen = startWitness();
    witnesses.push(staleDen, currentDen);
    let releaseStaleRead: (config: Record<string, unknown>) => void = () => {};
    const staleRead = new Promise<Record<string, unknown>>((resolve) => {
      releaseStaleRead = resolve;
    });
    installWindow({ shell: { reads: [{ kind: "defer", promise: staleRead }] } });

    const staleInitialize = initializeDenBootstrapConfig();
    await setDenBootstrapConfig({ baseUrl: currentDen.url, apiBaseUrl: currentDen.url, requireSignin: false });
    expect(readDenBootstrapConfig().baseUrl).toBe(currentDen.url);

    releaseStaleRead({ baseUrl: staleDen.url, apiBaseUrl: staleDen.url, requireSignin: false, fromFile: true });
    await staleInitialize;

    expect(readDenBootstrapConfig().baseUrl).toBe(currentDen.url);
    expect(readDenBootstrapConfig().apiBaseUrl).toBe(currentDen.url);
  });

  test("an explicitly configured hosted session keeps working", async () => {
    const storage = installWindow({
      shell: {
        reads: [{ kind: "config", config: { baseUrl: "https://app.openworklabs.com", requireSignin: false, fromFile: true } }],
      },
    });
    storage.setItem("openwork.den.authToken", "hosted-token-1");
    storage.setItem("openwork.den.activeOrgId", "org_hosted_1");
    storage.setItem(STORAGE_SESSION_ORIGIN, "https://app.openworklabs.com");

    await initializeDenBootstrapConfig();

    expect(getDenBootstrapResolution()).toBe("resolved");
    const settings = readDenSettings();
    expect(settings.baseUrl).toBe("https://app.openworklabs.com");
    expect(settings.authToken).toBe("hosted-token-1");
    expect(settings.activeOrgId).toBe("org_hosted_1");
  });

  test("a resolved bootstrap adopts a legacy untagged session for its proven origin", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({
      shell: {
        reads: [{ kind: "config", config: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false, fromFile: true } }],
      },
    });
    seedRetainedSession(storage, null);

    await initializeDenBootstrapConfig();

    expect(storage.getItem(STORAGE_SESSION_ORIGIN)).toBe(den.origin);
    expect(readDenSettings().authToken).toBe(RETAINED_TOKEN);
  });

  test("local-only startup stays usable with no retained session and an unresolved bootstrap", async () => {
    installWindow({ shell: { reads: [{ kind: "fail" }] } });

    const config = await initializeDenBootstrapConfig();

    expect(config.baseUrl.length).toBeGreaterThan(0);
    expect(getDenBootstrapResolution()).toBe("unresolved");
    const settings = readDenSettings();
    expect(settings.authToken).toBeNull();
    expect(await ensureDenActiveOrganization()).toBeNull();
    expect(credentialedFetches()).toEqual([]);
  });

  test("sign-out clears the session origin tag together with the session", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({
      shell: {
        reads: [{ kind: "config", config: { baseUrl: den.url, apiBaseUrl: den.url, requireSignin: false, fromFile: true } }],
      },
    });
    seedRetainedSession(storage, den.origin);
    await initializeDenBootstrapConfig();

    clearDenSession();

    expect(storage.getItem("openwork.den.authToken")).toBeNull();
    expect(storage.getItem(STORAGE_SESSION_ORIGIN)).toBeNull();
  });

  test("quarantine diagnostics never contain the retained secret", async () => {
    const den = startWitness();
    witnesses.push(den);
    const storage = installWindow({ shell: { reads: [{ kind: "fail" }] } });
    seedRetainedSession(storage, den.origin);

    await initializeDenBootstrapConfig();
    readDenSettings();

    expect(consoleLines.length).toBeGreaterThan(0);
    for (const line of consoleLines) {
      expect(line).not.toContain(RETAINED_TOKEN);
    }
  });
});
