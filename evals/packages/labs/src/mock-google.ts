import { parseMockGmailMime, startMockGoogleServer, type MockGoogleThread, type MockTokenScopes } from "./mock-google-server.ts";
import { trimTrailingSlashes } from "./strings.ts";

export type { MockTokenScopes };

export interface MockGoogleDraft {
  to: string;
  body: string;
  threadId?: string;
  draftId?: string;
  messageId?: string;
  returnedThreadId?: string | null;
  mime?: ReturnType<typeof parseMockGmailMime>;
  attachments?: MockGoogleAttachment[];
  /** Which credential created it — the isolation witness. */
  tokenId: string;
  at: string;
}

export interface MockGoogleAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: Buffer;
}

export interface MockGoogleDriveUpload extends MockGoogleAttachment {
  /** Which credential created it — the isolation witness. */
  tokenId: string;
  at: string;
}

export type { MockDriveFileSeed, MockDriveFileSnapshot } from "./mock-google-drive.ts";

export interface MockGoogleHandle {
  /** Base URL for DEN_GOOGLE_API_BASE_URL. */
  apiUrl: string;
  /** For DEN_GOOGLE_OAUTH_AUTHORIZE_URL / _TOKEN_URL / _USERINFO_URL. */
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** Drive the real chooser page shown when prompt=select_account. Resolves once the callback has been served. */
  chooseAccount(email: string, opts?: { timeoutMs?: number }): Promise<{ status: number; html: string }>;
  /** Drafts attributed to ONE mailbox. Must be able to return [] as a real negative assertion. */
  draftsFor(email: string, opts?: { since?: string; timeoutMs?: number; atLeast?: number }): Promise<MockGoogleDraft[]>;
  /** Drive uploads attributed to ONE account, including provider-observed bytes. */
  driveUploadsFor(email: string, opts?: { since?: string; timeoutMs?: number; atLeast?: number }): Promise<MockGoogleDriveUpload[]>;
  authorizeRequestSince(iso: string, opts?: { timeoutMs?: number }): Promise<{ params: URLSearchParams }>;
  /** Drive files ONE account can see, with current bytes and revisions. */
  driveFiles(email: string): Promise<import("./mock-google-drive.ts").MockDriveFileSnapshot[]>;
  /** Someone else edits a Drive file: new content and a new revision. */
  editDriveFile(email: string, id: string, content: Uint8Array): Promise<void>;
  /** Revoke every token issued for ONE account, as if the member removed the app's access. */
  revoke(email: string): Promise<void>;
  /** Token-endpoint requests seen so far, oldest first. */
  tokenRequests(): Promise<Record<string, unknown>[]>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface StartMockGoogleOptions {
  accounts: string[];
  port?: number;
  publicUrl?: string;
  autoApprove?: boolean;
  threads?: Record<string, MockGoogleThread[]>;
  accessTokenTtlSeconds?: number;
  driveFiles?: Record<string, import("./mock-google-drive.ts").MockDriveFileSeed[]>;
  /** "entra" reports token scopes the way Microsoft Entra ID does (no offline_access); add `withhold` for unconsented permissions. Default "echo". */
  tokenScopes?: MockTokenScopes;
}

export async function startMockGoogle(options: StartMockGoogleOptions): Promise<MockGoogleHandle> {
  const accounts = Array.from(new Set(options.accounts.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  if (accounts.length === 0) throw new Error("startMockGoogle requires at least one account.");
  const externalUrl = options.publicUrl ? trimTrailingSlashes(options.publicUrl.trim()) || undefined : undefined;
  const local = externalUrl
    ? null
    : await startMockGoogleServer({ accounts, port: options.port ?? 3980, autoApprove: options.autoApprove ?? true, threads: options.threads, accessTokenTtlSeconds: options.accessTokenTtlSeconds, driveFiles: options.driveFiles, tokenScopes: options.tokenScopes });
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
    if (typeof value.draftId === "string") draft.draftId = value.draftId;
    if (typeof value.messageId === "string") draft.messageId = value.messageId;
    if (typeof value.returnedThreadId === "string" || value.returnedThreadId === null) draft.returnedThreadId = value.returnedThreadId;
    if (typeof value.raw === "string") draft.mime = parseMockGmailMime(value.raw);
    if (Array.isArray(value.attachments)) {
      const attachments = value.attachments.flatMap((entry) => {
        const attachment = parseAttachment(entry);
        return attachment ? [attachment] : [];
      });
      if (attachments.length > 0) draft.attachments = attachments;
    }
    return draft;
  }

  function parseAttachment(value: unknown): MockGoogleAttachment | null {
    if (!isRecord(value)
      || typeof value.filename !== "string"
      || typeof value.mimeType !== "string"
      || typeof value.size !== "number"
      || typeof value.dataBase64 !== "string") return null;
    const content = Buffer.from(value.dataBase64, "base64");
    if (content.byteLength !== value.size) return null;
    return {
      filename: value.filename,
      mimeType: value.mimeType,
      size: value.size,
      content,
    };
  }

  function parseDriveUpload(value: unknown): MockGoogleDriveUpload | null {
    const attachment = parseAttachment(value);
    if (!attachment || !isRecord(value) || typeof value.tokenId !== "string" || typeof value.at !== "string") return null;
    return { ...attachment, tokenId: value.tokenId, at: value.at };
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

  async function readDriveUploads(email: string, since: string | undefined, timeoutMs: number): Promise<MockGoogleDriveUpload[]> {
    const endpoint = new URL("/__mock-google/drive-uploads", url);
    endpoint.searchParams.set("email", email.trim().toLowerCase());
    const body = await json(endpoint.toString(), timeoutMs);
    if (!isRecord(body) || !Array.isArray(body.uploads)) return [];
    return body.uploads.flatMap((value) => {
      const upload = parseDriveUpload(value);
      return upload && (!since || upload.at >= since) ? [upload] : [];
    });
  }

  async function pollForAtLeast<T>(
    read: (timeoutMs: number) => Promise<T[]>,
    atLeast: number | undefined,
    timeoutMs: number,
  ): Promise<T[]> {
    if (atLeast === undefined || atLeast <= 0) return read(timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let values = await read(Math.max(1, deadline - Date.now()));
    while (values.length < atLeast && Date.now() < deadline) {
      await sleep(250);
      values = await read(Math.max(1, deadline - Date.now()));
    }
    return values;
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
      const page = await fetch(callbackUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      return { status: page.status, html: await page.text() };
    },
    async draftsFor(email, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 120_000;
      return pollForAtLeast(
        (remainingMs) => readDrafts(email, opts.since, remainingMs),
        opts.atLeast,
        timeoutMs,
      );
    },
    async driveUploadsFor(email, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 120_000;
      return pollForAtLeast(
        (remainingMs) => readDriveUploads(email, opts.since, remainingMs),
        opts.atLeast,
        timeoutMs,
      );
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
    async driveFiles(email) {
      const body = await json(`${url}/__mock-google/drive-files?email=${encodeURIComponent(email)}`);
      return isRecord(body) && Array.isArray(body.files) ? body.files as import("./mock-google-drive.ts").MockDriveFileSnapshot[] : [];
    },
    async editDriveFile(email, id, content) {
      const response = await fetch(`${url}/__mock-google/drive-files/edit?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`, { method: "POST", body: new Uint8Array(content), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Mock Google edit failed: HTTP ${response.status}`);
    },
    async revoke(email) {
      const response = await fetch(`${url}/__mock-google/revoke?email=${encodeURIComponent(email)}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Mock Google revoke failed: HTTP ${response.status}`);
    },
    async tokenRequests() {
      return (await requests()).filter((entry) => entry.method === "POST" && entry.path === "/token");
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
