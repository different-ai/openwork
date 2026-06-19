import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import {
  callGoogleWorkspaceExtensionAction,
  createGoogleWorkspaceConnectFlowManager,
  googleWorkspaceDisconnect,
  googleWorkspaceSetActiveAccount,
  googleWorkspaceStatus,
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

const previousEnv = {
  devMode: process.env.OPENWORK_DEV_MODE,
  plaintextVault: process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT,
  clientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  legacyClientSecret: process.env.OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  brokerUrl: process.env.OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL,
};
const previousFetch = globalThis.fetch;

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];
}

afterEach(() => {
  restoreEnv("OPENWORK_DEV_MODE", previousEnv.devMode);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", previousEnv.plaintextVault);
  restoreEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.clientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.legacyClientSecret);
  restoreEnv("OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL", previousEnv.brokerUrl);
  globalThis.fetch = previousFetch;
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
            payload: { headers: [{ name: "Subject", value: "Quarterly report" }, { name: "From", value: "alice@example.com" }] },
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
          parts: [{ mimeType: "text/plain", body: { data: bodyData } }],
        },
      }), { status: 200 }),
      { preconnect: previousFetch.preconnect },
    );

    const result = await callGoogleWorkspaceExtensionAction(config, "gmail_get_message", { messageId: "m1" }, {});
    expect(result?.ok).toBe(true);
    expect(result?.result).toMatchObject({ id: "m1", subject: "Greetings", body: "Hello from Gmail" });
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
