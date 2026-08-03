import { startMockGoogleServer } from "./mock-google-server.ts";
import { trimTrailingSlashes } from "./strings.ts";

export interface MockGoogleDraft {
  to: string;
  body: string;
  threadId?: string;
  /** Which credential created it — the isolation witness. */
  tokenId: string;
  at: string;
}

export interface MockGoogleHandle {
  /** Base URL for DEN_GOOGLE_API_BASE_URL. */
  apiUrl: string;
  /** For DEN_GOOGLE_OAUTH_AUTHORIZE_URL / _TOKEN_URL / _USERINFO_URL. */
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** Drive the real chooser page shown when prompt=select_account. Resolves once the callback has been served. */
  chooseAccount(email: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Drafts attributed to ONE mailbox. Must be able to return [] as a real negative assertion. */
  draftsFor(email: string, opts?: { since?: string; timeoutMs?: number; atLeast?: number }): Promise<MockGoogleDraft[]>;
  authorizeRequestSince(iso: string, opts?: { timeoutMs?: number }): Promise<{ params: URLSearchParams }>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface StartMockGoogleOptions {
  accounts: string[];
  port?: number;
  publicUrl?: string;
  autoApprove?: boolean;
}

export async function startMockGoogle(options: StartMockGoogleOptions): Promise<MockGoogleHandle> {
  const accounts = Array.from(new Set(options.accounts.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  if (accounts.length === 0) throw new Error("startMockGoogle requires at least one account.");
  const externalUrl = options.publicUrl ? trimTrailingSlashes(options.publicUrl.trim()) || undefined : undefined;
  const local = externalUrl
    ? null
    : await startMockGoogleServer({ accounts, port: options.port ?? 3980, autoApprove: options.autoApprove ?? true });
  const url = externalUrl ?? local?.baseUrl;
  if (!url) throw new Error("Mock Google did not expose a URL.");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function stringArray(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
  }

  async function json(urlValue: string, timeoutMs = 30_000): Promise<unknown> {
    const response = await fetch(urlValue, { signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Mock Google request failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
    return body;
  }

  const healthDeadline = Date.now() + 30_000;
  let healthy = false;
  let healthDetail = "unreachable";
  while (Date.now() < healthDeadline) {
    try {
      const body = await json(`${url}/health`, 2_000);
      if (isRecord(body) && body.ok === true) {
        const servedAccounts = stringArray(body.accounts);
        if (servedAccounts && (servedAccounts.length !== accounts.length || servedAccounts.some((email, index) => email !== accounts[index]))) {
          throw new Error(`Mock Google account mismatch: expected ${accounts.join(", ")}; got ${servedAccounts.join(", ")}.`);
        }
        if (typeof body.autoApprove === "boolean" && body.autoApprove !== (options.autoApprove ?? true)) {
          throw new Error(`Mock Google autoApprove mismatch: expected ${options.autoApprove ?? true}; got ${body.autoApprove}.`);
        }
        healthy = true;
        break;
      }
      healthDetail = JSON.stringify(body);
    } catch (error) {
      healthDetail = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  if (!healthy) {
    await local?.stop();
    throw new Error(`Mock Google not reachable at ${url}. Last: ${healthDetail}`);
  }

  async function requests(): Promise<Record<string, unknown>[]> {
    const body = await json(`${url}/requests`);
    return isRecord(body) && Array.isArray(body.requests) ? body.requests.filter(isRecord) : [];
  }

  function parseDraft(value: unknown): MockGoogleDraft | null {
    if (!isRecord(value)
      || typeof value.to !== "string"
      || typeof value.body !== "string"
      || typeof value.tokenId !== "string"
      || typeof value.at !== "string") return null;
    const draft: MockGoogleDraft = {
      to: value.to,
      body: value.body,
      tokenId: value.tokenId,
      at: value.at,
    };
    if (typeof value.threadId === "string") draft.threadId = value.threadId;
    return draft;
  }

  async function readDrafts(email: string, since: string | undefined, timeoutMs: number): Promise<MockGoogleDraft[]> {
    const endpoint = new URL("/__mock-google/drafts", url);
    endpoint.searchParams.set("email", email.trim().toLowerCase());
    const body = await json(endpoint.toString(), timeoutMs);
    if (!isRecord(body) || !Array.isArray(body.drafts)) return [];
    return body.drafts.flatMap((value) => {
      const draft = parseDraft(value);
      return draft && (!since || draft.at >= since) ? [draft] : [];
    });
  }

  const stop = async (): Promise<void> => {
    await local?.stop();
  };

  return {
    apiUrl: url,
    authorizeUrl: `${url}/authorize`,
    tokenUrl: `${url}/token`,
    userinfoUrl: `${url}/userinfo`,
    async chooseAccount(email, opts = {}) {
      const normalizedEmail = email.trim().toLowerCase();
      if (!accounts.includes(normalizedEmail)) throw new Error(`Unknown mock Google account: ${email}`);
      const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
      let chooseUrl: string | null = null;
      while (!chooseUrl && Date.now() < deadline) {
        const body = await json(`${url}/__mock-google/pending-authorizations`, Math.max(1, deadline - Date.now()));
        const pending = isRecord(body) && Array.isArray(body.pending) ? body.pending.filter(isRecord) : [];
        for (const authorization of [...pending].reverse()) {
          if (!Array.isArray(authorization.accounts)) continue;
          const account = authorization.accounts.find((value) => isRecord(value) && value.email === normalizedEmail);
          if (isRecord(account) && typeof account.chooseUrl === "string") {
            chooseUrl = account.chooseUrl;
            break;
          }
        }
        if (!chooseUrl) await sleep(100);
      }
      if (!chooseUrl) throw new Error(`No pending mock Google account chooser offered ${normalizedEmail}.`);
      const remaining = Math.max(1, deadline - Date.now());
      const choice = await fetch(chooseUrl, { redirect: "manual", signal: AbortSignal.timeout(remaining) });
      const callbackUrl = choice.headers.get("location");
      if (choice.status !== 302 || !callbackUrl) {
        throw new Error(`Mock Google chooser failed: HTTP ${choice.status}`);
      }
      await fetch(callbackUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    },
    async draftsFor(email, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 120_000;
      if (opts.atLeast === undefined || opts.atLeast <= 0) {
        return readDrafts(email, opts.since, timeoutMs);
      }
      const deadline = Date.now() + timeoutMs;
      let drafts = await readDrafts(email, opts.since, Math.max(1, deadline - Date.now()));
      while (drafts.length < opts.atLeast && Date.now() < deadline) {
        await sleep(250);
        drafts = await readDrafts(email, opts.since, Math.max(1, deadline - Date.now()));
      }
      return drafts;
    },
    async authorizeRequestSince(iso, opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
      while (Date.now() < deadline) {
        const request = (await requests()).find((entry) => entry.method === "GET"
          && entry.path === "/authorize"
          && typeof entry.at === "string"
          && entry.at >= iso);
        if (request && typeof request.url === "string") {
          return { params: new URL(request.url, url).searchParams };
        }
        await sleep(100);
      }
      throw new Error(`No GET /authorize reached the mock Google provider after ${iso}.`);
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
