import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import {
  callGoogleWorkspaceExtensionAction,
  createGmailAttachmentPublicLookup,
  createGoogleWorkspaceConnectFlowManager,
  googleWorkspaceDisconnect,
  googleWorkspaceSetActiveAccount,
  googleWorkspaceStatus,
  setGmailAttachmentFetchForTests,
} from "./google-workspace.js";

function createTestConfig(): ServerConfig {
  const tempDir = join(
    tmpdir(),
    `openwork-google-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: join(tempDir, "server.json"),
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

function plaintextVaultPath(config: ServerConfig) {
  return join(dirname(config.configPath ?? ""), "extensions", "google-workspace", "oauth.dev-plaintext.json");
}

async function writePlaintextVault(config: ServerConfig, value: Record<string, unknown>) {
  const target = plaintextVaultPath(config);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function accountRecord(email: string, sub: string, scopes: string[] = ["openid"]) {
  return {
    account: { email, name: email, sub, picture: null },
    scopes,
    token: { accessToken: `access-${sub}`, refreshToken: `refresh-${sub}`, expiresAt: Date.now() + 3600 * 1000 },
    connectedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function decodeRawFromRequestBody(body: string): string {
  const raw = body.match(/"raw":"([^"]+)"/)?.[1] ?? "";
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

const previousEnv = {
  devMode: process.env.OPENWORK_DEV_MODE,
  plaintextVault: process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT,
  clientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  legacyClientSecret: process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  brokerUrl: process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
};
const previousFetch = globalThis.fetch;

// Attachment url validation resolves hostnames; answer from a fixture map so
// tests never touch real DNS. Unmapped hostnames resolve to a public address.
const dnsAnswers = new Map<string, string | Error>();
mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string) => {
    const answer = dnsAnswers.get(hostname);
    if (answer instanceof Error) throw answer;
    return [{ address: typeof answer === "string" ? answer : "93.184.216.34", family: 4 }];
  },
}));

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];
}

async function lookupAll(lookupFunction: LookupFunction, hostname: string): Promise<LookupAddress[]> {
  return await new Promise<LookupAddress[]>((resolve, reject) => {
    lookupFunction(hostname, { all: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      if (!Array.isArray(addresses)) {
        reject(new Error("Expected an all-address DNS lookup result."));
        return;
      }
      resolve(addresses);
    });
  });
}

beforeEach(() => {
  setGmailAttachmentFetchForTests((input, init) => globalThis.fetch(input, init));
});

afterEach(() => {
  dnsAnswers.clear();
  restoreEnv("OPENWORK_DEV_MODE", previousEnv.devMode);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", previousEnv.plaintextVault);
  restoreEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.clientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.legacyClientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL", previousEnv.brokerUrl);
  globalThis.fetch = previousFetch;
  setGmailAttachmentFetchForTests();
});

describe("Google Workspace extension", () => {
  test("reports only the user-configurable OAuth secret as missing", async () => {
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "";
    process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "";
    process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL = "";
    const status = await googleWorkspaceStatus(createTestConfig());
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET"]);
  });

  test("reads multi-account vaults and exposes active account", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-two",
      accounts: [accountRecord("one@example.com", "sub-one"), accountRecord("two@example.com", "sub-two")],
    });

    const status = await googleWorkspaceStatus(config);
    expect(status.connected).toBe(true);
    expect(status.account?.email).toBe("two@example.com");
    expect(status.accounts.map((account) => account.email)).toEqual(["one@example.com", "two@example.com"]);
    expect(status.activeAccountId).toBe("sub-two");
  });

  test("disconnect can remove one connected account", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    globalThis.fetch = Object.assign(
      async () => new Response("{}", { status: 200 }),
      { preconnect: previousFetch.preconnect },
    );
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one"), accountRecord("two@example.com", "sub-two")],
    });

    const status = await googleWorkspaceDisconnect(config, "sub-one");
    expect(status.connected).toBe(true);
    expect(status.accounts.map((account) => account.email)).toEqual(["two@example.com"]);
    expect(status.activeAccountId).toBe("sub-two");
  });

  test("gmail_list_messages rejects accounts without the gmail.readonly scope", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    expect(callGoogleWorkspaceExtensionAction(config, "gmail_list_messages", {}, {})).rejects.toThrow(
      new ApiError(403, "google_gmail_read_not_granted", "Gmail read access is not granted for this account. Reconnect Google Workspace with Gmail read access enabled."),
    );
  });

  test("gmail_list_messages returns message summaries", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const requestedUrls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        requestedUrls.push(url);
        if (url.includes("/messages/")) {
          return new Response(JSON.stringify({
            id: "m1",
            threadId: "t1",
            snippet: "Hello there",
            labelIds: ["INBOX", "UNREAD"],
            payload: { headers: [{ name: "Subject", value: "Quarterly report" }, { name: "From", value: "alice@example.com" }, { name: "Bcc", value: "investors@example.com" }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ messages: [{ id: "m1" }], resultSizeEstimate: 1 }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_list_messages", { query: "is:unread", maxResults: 5 }, {});
    expect(result?.ok).toBe(true);
    expect(result?.result).toEqual({
      messages: [{
        id: "m1",
        threadId: "t1",
        snippet: "Hello there",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Quarterly report",
        from: "alice@example.com",
        to: "",
        bcc: "investors@example.com",
        date: "",
      }],
      resultSizeEstimate: 1,
    });
    expect(requestedUrls[0]).toContain("q=is%3Aunread");
    expect(requestedUrls[0]).toContain("maxResults=5");
  });

  test("gmail_get_message decodes the plain text body", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const bodyData = Buffer.from("Hello from Gmail", "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({
        id: "m1",
        threadId: "t1",
        snippet: "Hello",
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "Subject", value: "Greetings" }],
          parts: [
            { mimeType: "text/plain", body: { data: bodyData } },
            { filename: "report.pdf", mimeType: "application/pdf", body: { attachmentId: "att-1", size: 42 } },
          ],
        },
      }), { status: 200 }),
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_get_message", { messageId: "m1" }, {});
    expect(result?.ok).toBe(true);
    expect(result?.result).toMatchObject({ id: "m1", subject: "Greetings", body: "Hello from Gmail" });
    expect(result?.result).toMatchObject({ attachments: [{ attachmentId: "att-1", filename: "report.pdf", mimeType: "application/pdf", size: 42 }] });
  });

  test("gmail_download_attachment decodes attachment data", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const attachmentData = Buffer.from("attachment bytes", "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const requestedUrls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requestedUrls.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify({ data: attachmentData, size: 16 }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_download_attachment", { messageId: "m1", attachmentId: "att-1" }, {});
    expect(result?.ok).toBe(true);
    expect(result?.result).toEqual({
      messageId: "m1",
      attachmentId: "att-1",
      size: 16,
      dataBase64: Buffer.from("attachment bytes", "utf8").toString("base64"),
    });
    expect(requestedUrls[0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/att-1");
  });

  test("drive_search_files escapes backslashes before apostrophes in query literals", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });
    let requestedUrl = "";
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requestedUrl = String(input instanceof Request ? input.url : input);
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    await callGoogleWorkspaceExtensionAction(config, "drive_search_files", { query: String.raw`reports\O'Brien` }, {});

    expect(new URL(requestedUrl).searchParams.get("q")).toBe(String.raw`name contains 'reports\\O\'Brien' and trashed = false`);
  });

  test("gmail_create_draft attaches local workspace files", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    const workspaceRoot = join(dirname(config.configPath ?? ""), "workspace");
    const invoicePath = join(workspaceRoot, "invoices", "acme-invoice-2026-001.pdf");
    config.workspaces = [{ id: "workspace-1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }];
    config.authorizedRoots = [workspaceRoot];
    await mkdir(dirname(invoicePath), { recursive: true });
    await writeFile(invoicePath, "%PDF-1.4\ninvoice bytes\n", "utf8");
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input instanceof Request ? input.url : input), body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", {
      to: ["accounts.payable@acme.test"],
      cc: ["purchasing.admin@acme.test", "casey.jordan@acme.test"],
      subject: "Invoice ACME-2026-001 for PO-000123",
      body: [
        "Please find attached invoice ACME-2026-001 for PO-000123 and review",
        "the proposed commercial terms before our next call.",
        "",
        "Thanks,",
        "OpenWork",
      ].join("\n"),
      attachments: [{ path: "invoices/acme-invoice-2026-001.pdf" }],
    }, { directory: workspaceRoot });
    expect(result?.ok).toBe(true);
    expect(result?.result).toMatchObject({ id: "draft-1" });
    expect(result?.result).toMatchObject({ draftUrl: "https://mail.google.com/mail/u/0/#drafts?compose=draft-message-1", threadUrl: null });
    expect(requests[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    const raw = requests[0]?.body.match(/"raw":"([^"]+)"/)?.[1] ?? "";
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("To: accounts.payable@acme.test");
    expect(decoded).toContain("Cc: purchasing.admin@acme.test, casey.jordan@acme.test");
    expect(decoded).toContain("Subject: Invoice ACME-2026-001 for PO-000123");
    expect(decoded).toContain("Content-Type: multipart/mixed;");
    expect(decoded).toContain("Content-Type: multipart/alternative;");
    expect(decoded).toContain("Content-Type: text/html; charset=UTF-8");
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("Please find attached invoice ACME-2026-001 for PO-000123 and review the proposed commercial terms before our next call.\r\n\r\nThanks,\r\nOpenWork");
    expect(decoded).toContain("Content-Type: application/pdf; name=\"acme-invoice-2026-001.pdf\"");
    expect(decoded).toContain("Content-Disposition: attachment; filename=\"acme-invoice-2026-001.pdf\"");
    expect(decoded).toContain(Buffer.from("%PDF-1.4\ninvoice bytes\n", "utf8").toString("base64"));
  });

  test("gmail_create_draft rejects reply-looking subjects", async () => {
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", {
      to: ["sam@acme.test"],
      subject: "Re: Project update",
      body: "Thanks",
    }, {})).rejects.toThrow(
      new ApiError(400, "invalid_payload", "Subject looks like a reply. Use gmail_create_reply_draft instead so the Gmail thread is preserved."),
    );
  });

  test("gmail_create_draft strips conservative markdown from prose", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input instanceof Request ? input.url : input), body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    await callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", {
      to: ["sam@acme.test"],
      subject: "Project update",
      body: [
        "# Status update",
        "",
        "Please **review** the __terms__ and `confirm` before launch.",
        "",
        "- **Keep list marker**",
        "> **Keep quoted text**",
        "```",
        "# keep fenced heading",
        "```",
      ].join("\n"),
    }, {});

    const raw = requests[0]?.body.match(/"raw":"([^"]+)"/)?.[1] ?? "";
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain([
      "Status update",
      "",
      "Please review the terms and confirm before launch.",
      "",
      "- **Keep list marker**",
      "> **Keep quoted text**",
      "```",
      "# keep fenced heading",
      "```",
    ].join("\r\n"));
  });

  test("gmail_create_reply_draft rejects accounts without the gmail.readonly scope", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    expect(callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", { messageId: "m1", body: "Thanks" }, {})).rejects.toThrow(
      new ApiError(403, "google_gmail_read_not_granted", "Gmail read access is not granted for this account. Reconnect Google Workspace with Gmail read access enabled."),
    );
  });

  test("gmail_create_reply_draft creates a threaded reply all draft", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/messages/m1")) {
          expect(url).toContain("format=full");
          return new Response(JSON.stringify({
            id: "m1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<message-1@example.com>" },
                { name: "References", value: "<root@example.com>" },
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "To", value: "One <one@example.com>, Bob <bob@example.com>" },
                { name: "Cc", value: "Carol <carol@example.com>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: base64Url("Original line\n> previous quote") } }],
            },
          }), { status: 200 });
        }
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", { messageId: "m1", body: "Thanks for the update.", replyAll: true }, {});
    expect(result?.ok).toBe(true);
    expect(result?.result).toMatchObject({
      id: "draft-1",
      draftUrl: "https://mail.google.com/mail/u/0/#drafts?compose=draft-message-1",
      threadUrl: "https://mail.google.com/mail/u/0/#all/thread-1",
    });
    expect(requests[0]?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(requests[0]?.body).toContain('"threadId":"thread-1"');
    const raw = requests[0]?.body.match(/"raw":"([^"]+)"/)?.[1] ?? "";
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("To: Alice <alice@example.com>, Bob <bob@example.com>");
    expect(decoded).toContain("Cc: Carol <carol@example.com>");
    expect(decoded).toContain("Subject: Re: Project update");
    expect(decoded).toContain("In-Reply-To: <message-1@example.com>");
    expect(decoded).toContain("References: <root@example.com> <message-1@example.com>");
    expect(decoded).toContain([
      "Thanks for the update.",
      "",
      "On Thu, 16 Jul 2026 at 15:21 UTC, Alice <alice@example.com> wrote:",
      "> Original line",
      "> > previous quote",
    ].join("\r\n"));
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("Content-Type: multipart/alternative;");
    expect(decoded).toContain("Content-Type: text/html; charset=UTF-8");
    expect(decoded).toContain('<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Thu, 16 Jul 2026 at 15:21 UTC, Alice &lt;alice@example.com&gt; wrote:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">');
    expect(decoded).toContain("<div>Original line</div><div>&gt; previous quote</div>");
    expect(decoded).not.toContain("one@example.com");
    expect(result?.result).toMatchObject({
      reply: {
        threadId: "thread-1",
        subject: "Re: Project update",
        to: ["Alice <alice@example.com>", "Bob <bob@example.com>"],
        cc: ["Carol <carol@example.com>"],
        inReplyTo: "<message-1@example.com>",
        original: { subject: "Project update", from: "Alice <alice@example.com>", date: "Thu, 16 Jul 2026 15:21:00 +0000" },
      },
    });
  });

  test("gmail_create_reply_draft quotes HTML-only originals in both parts", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/messages/m1")) {
          return new Response(JSON.stringify({
            id: "m1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<message-1@example.com>" },
                { name: "Subject", value: "Design review" },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{ mimeType: "text/html", body: { data: base64Url("<div>Hello<br>world &amp; more</div>") } }],
            },
          }), { status: 200 });
        }
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", { messageId: "m1", body: "Thanks!" }, {});
    expect(result?.ok).toBe(true);
    const decoded = decodeRawFromRequestBody(requests[0]?.body ?? "");
    expect(decoded).toContain("On Thu, 16 Jul 2026 at 15:21 UTC, Alice <alice@example.com> wrote:");
    expect(decoded).toContain("> Hello\r\n> world & more");
    expect(decoded).toContain('<blockquote class="gmail_quote"');
    expect(decoded).toContain("<div>Hello</div><div>world &amp; more</div>");
  });

  test("gmail_create_reply_draft does not append a second quote when the body already includes one", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/messages/m1")) {
          return new Response(JSON.stringify({
            id: "m1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<message-1@example.com>" },
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: base64Url("Original line") } }],
            },
          }), { status: 200 });
        }
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const body = [
      "Looks good to me.",
      "",
      "On Mon, 20 Jul 2026 at 10:00 UTC, Bob <bob@example.com> wrote:",
      "> earlier message",
    ].join("\n");
    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", { messageId: "m1", body }, {});
    expect(result?.ok).toBe(true);
    const decoded = decodeRawFromRequestBody(requests[0]?.body ?? "");
    expect(decoded).toContain("> earlier message");
    expect(decoded).not.toContain("On Thu, 16 Jul 2026 at 15:21 UTC");
    expect(decoded).not.toContain("<blockquote");
    expect(decoded).not.toContain("gmail_attr");
  });

  test("gmail_create_reply_draft rejects messages without thread metadata", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({
        id: "m1",
        threadId: "thread-1",
        payload: { headers: [{ name: "Subject", value: "No message id" }, { name: "From", value: "Alice <alice@example.com>" }] },
      }), { status: 200 }),
      { preconnect: previousFetch.preconnect },
    );

    await expect(callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", { messageId: "m1", body: "Thanks" }, {})).rejects.toThrow(
      "Gmail message is missing thread metadata required to create a reply draft.",
    );
  });

  test("gmail_create_reply_draft attaches workspace files inside the threaded reply", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    const workspaceRoot = join(dirname(config.configPath ?? ""), "workspace");
    const reportPath = join(workspaceRoot, "reports", "summary-q3.pdf");
    config.workspaces = [{ id: "workspace-1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }];
    config.authorizedRoots = [workspaceRoot];
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, "%PDF-1.4\nsummary\n", "utf8");
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/messages/m1")) {
          return new Response(JSON.stringify({
            id: "m1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<message-1@example.com>" },
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: base64Url("Original line") } }],
            },
          }), { status: 200 });
        }
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", {
      messageId: "m1",
      body: "Summary attached.",
      attachments: [{ path: "reports/summary-q3.pdf" }],
    }, { directory: workspaceRoot });
    expect(result?.ok).toBe(true);
    expect(requests[0]?.body).toContain('"threadId":"thread-1"');
    const decoded = decodeRawFromRequestBody(requests[0]?.body ?? "");
    expect(decoded).toContain("In-Reply-To: <message-1@example.com>");
    expect(decoded).toContain("Content-Type: multipart/mixed;");
    expect(decoded).toContain("Content-Type: multipart/alternative;");
    expect(decoded).toContain("Content-Disposition: attachment; filename=\"summary-q3.pdf\"");
    expect(decoded).toContain(Buffer.from("%PDF-1.4\nsummary\n", "utf8").toString("base64"));
  });

  test("gmail_create_reply_draft folds long References headers", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const references = Array.from({ length: 8 }, (_, index) => `<thread-ref-${index + 1}@example.com>`).join(" ");
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/messages/m1")) {
          return new Response(JSON.stringify({
            id: "m1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<message-1@example.com>" },
                { name: "References", value: references },
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: base64Url("Original line") } }],
            },
          }), { status: 200 });
        }
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", { messageId: "m1", body: "Thanks!" }, {});
    expect(result?.ok).toBe(true);
    const decoded = decodeRawFromRequestBody(requests[0]?.body ?? "");
    const headerSection = decoded.split("\r\n\r\n")[0] ?? "";
    for (const line of headerSection.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    expect(headerSection).toContain("\r\n <thread-ref-");
    const unfolded = headerSection.replace(/\r\n /g, " ");
    expect(unfolded).toContain(`References: ${references} <message-1@example.com>`);
  });

  test("gmail_create_reply_draft drops display-name fragments from unquoted commas", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/gmail.readonly"])],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/messages/m1")) {
          return new Response(JSON.stringify({
            id: "m1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<message-1@example.com>" },
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "To", value: "Doe, John <j@x.example>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: base64Url("Original line") } }],
            },
          }), { status: 200 });
        }
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", { messageId: "m1", body: "Thanks!", replyAll: true }, {});
    expect(result?.ok).toBe(true);
    const reply = (result?.result as { reply?: { to?: string[] } })?.reply;
    expect(reply?.to).toEqual(["Alice <alice@example.com>", "John <j@x.example>"]);
  });

  test("gmail_create_draft rejects forward-looking subjects", async () => {
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", {
      to: ["sam@acme.test"],
      subject: "Fwd: Project update",
      body: "Thanks",
    }, {})).rejects.toThrow(
      new ApiError(400, "invalid_payload", "Subject looks like a reply. Use gmail_create_reply_draft instead so the Gmail thread is preserved."),
    );
  });

  test("gmail_create_draft encodes non-ASCII subjects", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input instanceof Request ? input.url : input), body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    await callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", {
      to: ["sam@acme.test"],
      subject: "Résumé update ✓",
      body: "New details inside.",
    }, {});
    const decoded = decodeRawFromRequestBody(requests[0]?.body ?? "");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).not.toContain("Subject: Résumé");
    const subjectLine = decoded.split("\r\n").find((line) => line.startsWith("Subject: ")) ?? "";
    const encodedWords = [...subjectLine.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
    expect(encodedWords.join("")).toBe("Résumé update ✓");
  });

  test("gmail_create_draft neutralizes CRLF header injection", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input instanceof Request ? input.url : input), body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    await callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", {
      to: ["sam@acme.test\r\nX-Evil: injected"],
      subject: "Hello\r\nBcc: evil@example.com",
      body: "Greetings.",
    }, {});
    const decoded = decodeRawFromRequestBody(requests[0]?.body ?? "");
    expect(decoded).toContain("Subject: Hello Bcc: evil@example.com");
    expect(decoded).not.toContain("\r\nBcc: evil@example.com");
    expect(decoded).toContain("To: sam@acme.test X-Evil: injected");
    expect(decoded).not.toContain("\r\nX-Evil: injected");
  });

  test("gmail_create_draft attaches files downloaded from https URLs", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });
    const fetchCalls: { url: string; redirect?: string }[] = [];
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        fetchCalls.push({ url, redirect: typeof init?.redirect === "string" ? init.redirect : undefined });
        if (url === "https://files.example.test/docs/report.pdf") {
          return new Response(null, { status: 302, headers: { location: "https://cdn.example.test/report-final.pdf" } });
        }
        if (url === "https://cdn.example.test/report-final.pdf") {
          return new Response("PDF BYTES", { status: 200, headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename=\"quarterly-report.pdf\"" } });
        }
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "draft-1", message: { id: "draft-message-1" } }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", {
      to: ["sam@acme.test"],
      subject: "Quarterly report",
      body: "Report attached.",
      attachments: [{ url: "https://files.example.test/docs/report.pdf" }],
    }, {});
    expect(result?.ok).toBe(true);
    expect(fetchCalls.find((call) => call.url === "https://files.example.test/docs/report.pdf")?.redirect).toBe("manual");
    expect(fetchCalls.find((call) => call.url === "https://cdn.example.test/report-final.pdf")?.redirect).toBe("manual");
    const decoded = decodeRawFromRequestBody(requests[0]?.body ?? "");
    expect(decoded).toContain("Content-Type: application/pdf; name=\"quarterly-report.pdf\"");
    expect(decoded).toContain("Content-Disposition: attachment; filename=\"quarterly-report.pdf\"");
    expect(decoded).toContain(Buffer.from("PDF BYTES", "utf8").toString("base64"));
  });

  test("gmail_create_draft rejects non-https, private, and redirect-downgraded attachment urls", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const draftArgs = (attachment: Record<string, unknown>) => ({
      to: ["sam@acme.test"],
      subject: "Files",
      body: "See attached.",
      attachments: [attachment],
    });

    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({ url: "http://files.example.test/report.pdf" }), {})).rejects.toThrow("Attachment url must be a public https URL");
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({ url: "https://localhost/report.pdf" }), {})).rejects.toThrow("Attachment url must be a public https URL");
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({ url: "https://192.168.1.10/report.pdf" }), {})).rejects.toThrow("Attachment url must be a public https URL");
    dnsAnswers.set("internal.corp.example", "10.0.0.5");
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({ url: "https://internal.corp.example/report.pdf" }), {})).rejects.toThrow("Attachment url must resolve to a public address");
    dnsAnswers.set("missing.example.test", new Error("NXDOMAIN"));
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({ url: "https://missing.example.test/report.pdf" }), {})).rejects.toThrow("Attachment url hostname could not be resolved");
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({}), {})).rejects.toThrow("Each attachment must provide exactly one of url or path");
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({ path: "report.pdf", url: "https://files.example.test/report.pdf" }), {})).rejects.toThrow("Each attachment must provide exactly one of url or path");

    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://files.example.test/report.pdf") {
          return new Response(null, { status: 302, headers: { location: "http://cdn.example.test/report.pdf" } });
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs({ url: "https://files.example.test/report.pdf" }), {})).rejects.toThrow("Attachment url must be a public https URL");
  });

  test("gmail attachment socket lookup rejects a private DNS-rebinding answer", async () => {
    let resolverCalls = 0;
    const socketLookup = createGmailAttachmentPublicLookup(async () => {
      resolverCalls += 1;
      return resolverCalls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    });

    await expect(lookupAll(socketLookup, "files.example.test")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
    await expect(lookupAll(socketLookup, "files.example.test")).rejects.toThrow(
      "resolved to a private or reserved address",
    );
    expect(resolverCalls).toBe(2);
  });

  test("gmail_create_draft enforces the attachment size cap on url downloads", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const draftArgs = {
      to: ["sam@acme.test"],
      subject: "Files",
      body: "See attached.",
      attachments: [{ url: "https://files.example.test/huge.bin" }],
    };

    globalThis.fetch = Object.assign(
      async () => new Response("x", { status: 200, headers: { "content-length": String(21 * 1024 * 1024) } }),
      { preconnect: previousFetch.preconnect },
    );
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs, {})).rejects.toThrow("Gmail draft attachments support files up to");

    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    globalThis.fetch = Object.assign(
      async () => new Response(new ReadableStream({
        pull(controller) {
          if (sent >= 21) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(chunk);
        },
      }), { status: 200 }),
      { preconnect: previousFetch.preconnect },
    );
    await expect(callGoogleWorkspaceExtensionAction(createTestConfig(), "gmail_create_draft", draftArgs, {})).rejects.toThrow("Gmail draft attachments support files up to");
  });

  test("gmail_create_draft rejects oversized and symlink-escaping path attachments", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    const workspaceRoot = join(dirname(config.configPath ?? ""), "workspace");
    const outsideDir = join(dirname(config.configPath ?? ""), "outside");
    config.workspaces = [{ id: "workspace-1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }];
    config.authorizedRoots = [workspaceRoot];
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(workspaceRoot, "huge.bin"), Buffer.alloc(21 * 1024 * 1024));
    await writeFile(join(outsideDir, "secret.txt"), "secret", "utf8");
    await symlink(join(outsideDir, "secret.txt"), join(workspaceRoot, "leak.txt"));

    const draftArgs = (path: string) => ({
      to: ["sam@acme.test"],
      subject: "Files",
      body: "See attached.",
      attachments: [{ path }],
    });
    await expect(callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", draftArgs("huge.bin"), { directory: workspaceRoot })).rejects.toThrow("Gmail draft attachments support files up to");
    await expect(callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", draftArgs("leak.txt"), { directory: workspaceRoot })).rejects.toThrow("Attachment path must resolve inside an authorized workspace root");
  });

  test("calendar_create_event rejects accounts without the calendar.events scope", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    expect(callGoogleWorkspaceExtensionAction(config, "calendar_create_event", { summary: "Sync", start: "2026-06-12T10:00:00Z", end: "2026-06-12T11:00:00Z" }, {})).rejects.toThrow(
      new ApiError(403, "google_calendar_write_not_granted", "Calendar editing access is not granted for this account. Reconnect Google Workspace with calendar editing enabled."),
    );
  });

  test("calendar_create_event creates events when the scope is granted", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/calendar.events"])],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input instanceof Request ? input.url : input), body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ id: "event-1", htmlLink: "https://calendar.google.com/event-1" }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "calendar_create_event", {
      summary: "Sync",
      start: "2026-06-12T10:00:00Z",
      end: "2026-06-12T11:00:00Z",
      attendees: ["alice@example.com"],
    }, {});
    expect(result?.ok).toBe(true);
    expect(result?.result).toMatchObject({ id: "event-1" });
    expect(requests[0]?.url).toContain("/calendar/v3/calendars/primary/events");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ summary: "Sync", attendees: [{ email: "alice@example.com" }] });
  });

  test("chat actions reject accounts without Google Chat scopes", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one")],
    });

    expect(callGoogleWorkspaceExtensionAction(config, "chat_list_spaces", {}, {})).rejects.toThrow(
      new ApiError(403, "google_chat_not_granted", "Google Chat access is not granted for this account. Reconnect Google Workspace with Google Chat enabled."),
    );
    expect(callGoogleWorkspaceExtensionAction(config, "chat_send_message", { spaceId: "spaces/AAA", text: "hi" }, {})).rejects.toThrow(
      new ApiError(403, "google_chat_not_granted", "Google Chat access is not granted for this account. Reconnect Google Workspace with Google Chat enabled."),
    );
  });

  test("chat_send_message posts to the chat space when the scope is granted", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one", ["openid", "https://www.googleapis.com/auth/chat.messages.create"])],
    });
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input instanceof Request ? input.url : input), body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ name: "spaces/AAA/messages/m1" }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "chat_send_message", { spaceId: "AAA", text: "hi" }, {});
    expect(result?.ok).toBe(true);
    expect(requests[0]?.url).toBe("https://chat.googleapis.com/v1/spaces/AAA/messages");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ text: "hi" });
  });

  test("connect start rejects optional features without a custom OAuth client", async () => {
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const flows = createGoogleWorkspaceConnectFlowManager(createTestConfig());
    expect(flows.start({ features: ["driveFull"] })).rejects.toThrow(
      new ApiError(400, "google_extra_scopes_require_custom_client", "Extra Google permissions (Gmail read, full Drive, calendar editing, Google Chat) are only available when using your own Google OAuth client."),
    );
    expect(flows.start({ gmailRead: true })).rejects.toThrow(
      new ApiError(400, "google_extra_scopes_require_custom_client", "Extra Google permissions (Gmail read, full Drive, calendar editing, Google Chat) are only available when using your own Google OAuth client."),
    );
  });

  test("can update the active account", async () => {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "secret";
    const config = createTestConfig();
    await writePlaintextVault(config, {
      version: 2,
      activeAccountId: "sub-one",
      accounts: [accountRecord("one@example.com", "sub-one"), accountRecord("two@example.com", "sub-two")],
    });

    const status = await googleWorkspaceSetActiveAccount(config, "sub-two");
    expect(status.account?.email).toBe("two@example.com");
    expect(status.accounts.map((account) => account.email)).toEqual(["one@example.com", "two@example.com"]);
    expect(status.activeAccountId).toBe("sub-two");
  });
});
