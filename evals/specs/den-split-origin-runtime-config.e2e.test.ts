import { execFile } from "node:child_process";
import { expect } from "vitest";
import { evalIn, signInInBrowser, waitFor } from "@openwork/behaviors";
import { chrome, localHost } from "@openwork/hosts";
import {
  ensureKubeStack,
  KUBE_CONTEXT,
  KUBE_RELEASE_NAME,
  kindServer,
  needs,
  test,
} from "@openwork/testkit";

const FETCH_RECORD_KEY = "openwork:eval:den-split-origin-fetches";
const INTERNAL_API_URL = `http://${KUBE_RELEASE_NAME}-den-api:8788`;

interface CapturedRequest {
  url: string;
  method: string;
  status: number | null;
  failure: string | null;
}

interface BrowserMeResult {
  url: string;
  status: number | null;
  tokenPresent: boolean;
  email: string | null;
  failure: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readRequiredRecord(value: unknown, key: string, label: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value[key])) {
    throw new Error(`${label}.${key} was not an object.`);
  }
  return value[key];
}

function readRequiredString(value: unknown, key: string, label: string): string {
  if (!isRecord(value) || typeof value[key] !== "string" || !value[key].trim()) {
    throw new Error(`${label}.${key} was not a non-empty string.`);
  }
  return value[key];
}

function readRequiredBoolean(value: unknown, key: string, label: string): boolean {
  if (!isRecord(value) || typeof value[key] !== "boolean") {
    throw new Error(`${label}.${key} was not a boolean.`);
  }
  return value[key];
}

function parseCapturedRequests(value: unknown): CapturedRequest[] {
  if (!Array.isArray(value)) {
    throw new Error(`Fetch recorder returned a non-array value: ${JSON.stringify(value)}`);
  }
  const requests: CapturedRequest[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || typeof entry.url !== "string"
      || typeof entry.method !== "string"
      || (typeof entry.status !== "number" && entry.status !== null)
      || (typeof entry.failure !== "string" && entry.failure !== null)
    ) {
      throw new Error(`Fetch recorder returned an invalid entry: ${JSON.stringify(entry)}`);
    }
    requests.push({ url: entry.url, method: entry.method, status: entry.status, failure: entry.failure });
  }
  return requests;
}

function parseBrowserMeResult(value: unknown): BrowserMeResult {
  if (
    !isRecord(value)
    || typeof value.url !== "string"
    || (typeof value.status !== "number" && value.status !== null)
    || typeof value.tokenPresent !== "boolean"
    || (typeof value.email !== "string" && value.email !== null)
    || (typeof value.failure !== "string" && value.failure !== null)
  ) {
    throw new Error(`Browser /v1/me result had an unexpected shape: ${JSON.stringify(value)}`);
  }
  return {
    url: value.url,
    status: value.status,
    tokenPresent: value.tokenPresent,
    email: value.email,
    failure: value.failure,
  };
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function fetchRecorderSource(): string {
  return `(() => {
    const storageKey = ${JSON.stringify(FETCH_RECORD_KEY)};
    const originalFetch = window.fetch.bind(window);
    const readRequests = () => {
      try {
        const parsed = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    window.fetch = async (input, init) => {
      const inputUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = new URL(inputUrl, location.href).href;
      try {
        const response = await originalFetch(input, init);
        const requests = readRequests();
        requests.push({ url, method, status: response.status, failure: null });
        sessionStorage.setItem(storageKey, JSON.stringify(requests));
        return response;
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        const requests = readRequests();
        requests.push({ url, method, status: null, failure });
        sessionStorage.setItem(storageKey, JSON.stringify(requests));
        throw error;
      }
    };
  })();`;
}

function isAuthRequest(request: CapturedRequest): boolean {
  return new URL(request.url).pathname.startsWith("/api/auth/");
}

function isApiRequest(request: CapturedRequest): boolean {
  return new URL(request.url).pathname.startsWith("/v1/");
}

test("Den Web sends browser auth and API traffic to the public API origin", { timeout: 30 * 60_000 }, async ({ evidence }) => {
  needs({
    optIn: ["OPENWORK_EVAL_KIND_E2E"],
    commands: ["kind", "kubectl", "helm", "docker"],
  });

  await ensureKubeStack({
    cdpCandidates: [],
    skipApp: true,
    profile: "single-org",
    images: "local",
    log: (message) => console.error(`[openwork/testkit] ${message}`),
  });
  await runCommand("kubectl", [
    "--context",
    KUBE_CONTEXT,
    "rollout",
    "restart",
    `deployment/${KUBE_RELEASE_NAME}-den-web`,
  ], 30_000);
  await runCommand("kubectl", [
    "--context",
    KUBE_CONTEXT,
    "rollout",
    "status",
    `deployment/${KUBE_RELEASE_NAME}-den-web`,
    "--timeout=300s",
  ], 360_000);

  await using den = await kindServer();

  const configMapText = await runCommand("kubectl", [
    "--context",
    KUBE_CONTEXT,
    "get",
    "configmap",
    `${KUBE_RELEASE_NAME}-config`,
    "-o",
    "json",
  ], 30_000);
  const configMap = parseJson(configMapText, "Helm ConfigMap");
  const configData = readRequiredRecord(configMap, "data", "Helm ConfigMap");
  const internalApiUrl = readRequiredString(configData, "DEN_API_BASE", "Helm ConfigMap.data");
  const publicApiUrl = readRequiredString(configData, "DEN_API_PUBLIC_URL", "Helm ConfigMap.data");
  const configMapIsSplit = internalApiUrl === INTERNAL_API_URL && publicApiUrl === den.ref.apiUrl;
  evidence.recordAssertionEvidence(
    "The Helm ConfigMap keeps the server-only API base separate from the browser-facing API URL",
    `DEN_API_BASE=${internalApiUrl}; DEN_API_PUBLIC_URL=${publicApiUrl}.`,
    configMapIsSplit,
  );
  expect(internalApiUrl).toBe(INTERNAL_API_URL);
  expect(publicApiUrl).toBe(den.ref.apiUrl);

  const readyResponse = await fetch(`${den.ref.webUrl}/api/ready`, {
    signal: AbortSignal.timeout(15_000),
  });
  const readyPayload = parseJson(await readyResponse.text(), "Den Web readiness response");
  const readyChecks = readRequiredRecord(readyPayload, "checks", "Den Web readiness response");
  const upstreamStatus = readRequiredString(readyChecks, "upstream", "Den Web readiness response.checks");
  const internalApiIsReady = readyResponse.status === 200 && upstreamStatus === "ok";
  evidence.recordAssertionEvidence(
    "Den Web can reach Den API through the server-only in-cluster DEN_API_BASE",
    `GET /api/ready returned ${readyResponse.status} with upstream=${upstreamStatus} for DEN_API_BASE=${internalApiUrl}.`,
    internalApiIsReady,
  );
  expect(readyResponse.status).toBe(200);
  expect(upstreamStatus).toBe("ok");

  const runtimeResponse = await fetch(`${den.ref.webUrl}/api/runtime-config`, {
    signal: AbortSignal.timeout(15_000),
  });
  const runtimeText = await runtimeResponse.text();
  const runtimeConfig = parseJson(runtimeText, "Den Web runtime config");
  const runtimeApiUrl = readRequiredString(runtimeConfig, "denApiUrl", "Den Web runtime config");
  const internalHostname = new URL(internalApiUrl).hostname;
  const runtimeConfigIsPublic = runtimeResponse.status === 200
    && runtimeApiUrl === den.ref.apiUrl
    && runtimeApiUrl !== internalApiUrl
    && !runtimeText.includes(internalHostname);
  evidence.recordAssertionEvidence(
    "Den Web runtime config exposes only the browser-facing API URL",
    `HTTP ${runtimeResponse.status}; denApiUrl=${runtimeApiUrl}; internal hostname absent=${!runtimeText.includes(internalHostname)}.`,
    runtimeConfigIsPublic,
  );
  expect(runtimeResponse.status).toBe(200);
  expect(runtimeApiUrl).toBe(den.ref.apiUrl);
  expect(runtimeApiUrl).not.toBe(internalApiUrl);
  expect(runtimeText).not.toContain(internalHostname);

  await using browser = await chrome({
    host: localHost(),
    name: "den-split-origin-runtime-config",
    startUrl: "about:blank",
    headless: true,
    timeoutMs: 60_000,
  });
  await browser.client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: fetchRecorderSource(),
  });
  await signInInBrowser(browser, `${den.ref.webUrl}/dashboard`, {
    email: "alex@acme.test",
    password: "OpenWorkDemo123!",
  });
  const signInOutcome = await evalIn(browser, `({
    pathname: location.pathname,
    signedIn: /signed in/i.test(document.body?.innerText ?? ""),
  })`, { timeoutMs: 10_000 });
  const dashboardPath = readRequiredString(signInOutcome, "pathname", "Browser sign-in outcome");
  const signedInText = readRequiredBoolean(signInOutcome, "signedIn", "Browser sign-in outcome");
  const signedInOutcomeObserved = dashboardPath.startsWith("/dashboard") || signedInText;
  expect(signedInOutcomeObserved).toBe(true);

  const publicApiOrigin = new URL(den.ref.apiUrl).origin;
  const meUrl = `${publicApiOrigin}/v1/me`;
  const meValue = await evalIn(browser, `(async () => {
    const token = localStorage.getItem("openwork:web:auth-token")?.trim() ?? "";
    const headers = new Headers({ Accept: "application/json" });
    if (token) headers.set("Authorization", "Bearer " + token);
    try {
      const response = await fetch(${JSON.stringify(meUrl)}, { headers, credentials: "include" });
      const payload = await response.json().catch(() => null);
      return {
        url: response.url,
        status: response.status,
        tokenPresent: Boolean(token),
        email: payload && typeof payload === "object" && payload.user && typeof payload.user === "object"
          && typeof payload.user.email === "string" ? payload.user.email : null,
        failure: null,
      };
    } catch (error) {
      return {
        url: ${JSON.stringify(meUrl)},
        status: null,
        tokenPresent: Boolean(token),
        email: null,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  const meResult = parseBrowserMeResult(meValue);
  expect(meResult.status).toBe(200);
  expect(meResult.email).toBe("alex@acme.test");
  expect(new URL(meResult.url).origin).toBe(publicApiOrigin);
  expect(meResult.failure).toBeNull();

  await waitFor(browser, `(() => {
    try {
      const requests = JSON.parse(sessionStorage.getItem(${JSON.stringify(FETCH_RECORD_KEY)}) || "[]");
      return Array.isArray(requests)
        && requests.some((entry) => typeof entry?.url === "string"
          && new URL(entry.url).pathname.startsWith("/api/auth/")
          && entry.method === "POST"
          && entry.status >= 200
          && entry.status < 300
          && entry.failure === null)
        && requests.some((entry) => entry?.url === ${JSON.stringify(meUrl)}
          && entry.method === "GET"
          && entry.status === 200
          && entry.failure === null);
    } catch {
      return false;
    }
  })()`, {
    timeoutMs: 30_000,
    label: "browser auth and API fetches recorded",
  });

  const capturedValue = await evalIn(browser, `(() => {
    try {
      return JSON.parse(sessionStorage.getItem(${JSON.stringify(FETCH_RECORD_KEY)}) || "[]");
    } catch {
      return [];
    }
  })()`, { timeoutMs: 10_000 });
  const capturedRequests = parseCapturedRequests(capturedValue);
  const authRequests = capturedRequests.filter(isAuthRequest);
  const apiRequests = capturedRequests.filter(isApiRequest);
  const backendRequests = [...authRequests, ...apiRequests];
  const successfulPostAuthRequests = authRequests.filter((request) => request.method === "POST"
    && request.status !== null
    && request.status >= 200
    && request.status < 300
    && request.failure === null
    && new URL(request.url).origin === publicApiOrigin);
  const successfulAuthenticatedRequest = apiRequests.find((request) => request.url === meUrl
    && request.method === "GET"
    && request.status === 200
    && request.failure === null);
  const backendOrigins = new Set(backendRequests.map((request) => new URL(request.url).origin));
  const internalRequests = capturedRequests.filter((request) => new URL(request.url).hostname === internalHostname);
  const browserUsedOnlyPublicApi = signedInOutcomeObserved
    && successfulPostAuthRequests.length > 0
    && successfulAuthenticatedRequest !== undefined
    && meResult.status === 200
    && internalRequests.length === 0;
  evidence.recordAssertionEvidence(
    "Real browser sign-in and authenticated API traffic complete on the public API origin and never use the in-cluster service",
    `Outcome=${dashboardPath}; successful POST auth=${successfulPostAuthRequests.length}; /v1/me=${meResult.status} for ${meResult.email}; token present=${meResult.tokenPresent}; origins=${JSON.stringify([...backendOrigins])}; internal requests=${internalRequests.length}.`,
    browserUsedOnlyPublicApi,
  );
  expect(successfulPostAuthRequests.length).toBeGreaterThan(0);
  expect(successfulAuthenticatedRequest).toBeDefined();
  expect(backendOrigins.has(publicApiOrigin)).toBe(true);
  expect(internalRequests).toHaveLength(0);
});
