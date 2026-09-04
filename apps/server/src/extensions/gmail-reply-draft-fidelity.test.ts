import { expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ServerConfig } from "../types.js";
import {
  callGoogleWorkspaceExtensionAction,
  createGmailAttachmentPublicLookup,
  setGmailAttachmentFetchForTests,
} from "./google-workspace.js";

function createTestConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 30_000 },
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

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeRawDraft(requestBody: string): string {
  const raw = requestBody.match(/"raw":"([^"]+)"/)?.[1] ?? "";
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

test("Gmail reply drafts preserve thread fidelity and bind public attachment DNS to the socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-gmail-reply-proof-"));
  const config = createTestConfig(root);
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    devMode: process.env.OPENWORK_DEV_MODE,
    plaintextVault: process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT,
    clientSecret: process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
  };
  const googleRequests: { url: string; body: string }[] = [];
  const attachmentRequests: { url: string; redirect?: string }[] = [];

  try {
    process.env.OPENWORK_DEV_MODE = "1";
    process.env.OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT = "1";
    process.env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET = "proof-secret";
    const vaultPath = join(dirname(config.configPath ?? ""), "extensions", "google-workspace", "oauth.dev-plaintext.json");
    await mkdir(dirname(vaultPath), { recursive: true });
    await writeFile(vaultPath, JSON.stringify({
      version: 2,
      activeAccountId: "proof-account",
      accounts: [{
        account: { email: "owner@example.com", name: "Owner", sub: "proof-account", picture: null },
        scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
        token: {
          accessToken: "proof-access-token",
          refreshToken: "proof-refresh-token",
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }));

    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/messages/message-1")) {
          return new Response(JSON.stringify({
            id: "message-1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<message-1@example.com>" },
                { name: "Subject", value: "Design review" },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{
                mimeType: "text/html",
                body: { data: base64Url("<div>Hello<br>world &amp; more<script>alert(1)</script></div>") },
              }],
            },
          }), { status: 200 });
        }
        googleRequests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({
          id: "draft-1",
          message: { id: "draft-message-1", threadId: "thread-1" },
        }), { status: 200 });
      },
      { preconnect: previousFetch.preconnect },
    );

    setGmailAttachmentFetchForTests(async (input, init) => {
      attachmentRequests.push({ url: input.toString(), redirect: init?.redirect });
      return new Response("PDF BYTES", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=design-review.pdf",
        },
      });
    });

    const reply = await callGoogleWorkspaceExtensionAction(config, "gmail_create_reply_draft", {
      messageId: "message-1",
      body: "Thanks for the review.",
      attachments: [{ url: "https://93.184.216.34/design-review.pdf" }],
    }, {});
    const raw = decodeRawDraft(googleRequests[0]?.body ?? "");

    expect(reply?.result).toMatchObject({
      draftUrl: "https://mail.google.com/mail/u/0/#drafts?compose=draft-message-1",
      threadUrl: "https://mail.google.com/mail/u/0/#all/thread-1",
      reply: {
        threadId: "thread-1",
        subject: "Re: Design review",
        to: ["Alice <alice@example.com>"],
        inReplyTo: "<message-1@example.com>",
      },
    });
    expect(raw).toContain("Content-Type: multipart/mixed;");
    expect(raw).toContain("Content-Type: multipart/alternative;");
    expect(raw).toContain("In-Reply-To: <message-1@example.com>");
    expect(raw).toContain("> Hello\r\n> world & more");
    expect(raw).toContain('<blockquote class="gmail_quote"');
    expect(raw).toContain("<div>Hello</div><div>world &amp; more</div>");
    expect(raw).not.toContain("alert(1)");
    expect(raw).not.toContain("<script");
    expect(raw).toContain('Content-Disposition: attachment; filename="design-review.pdf"');
    expect(raw).toContain(Buffer.from("PDF BYTES", "utf8").toString("base64"));
    expect(attachmentRequests).toEqual([{
      url: "https://93.184.216.34/design-review.pdf",
      redirect: "manual",
    }]);

    await expect(callGoogleWorkspaceExtensionAction(config, "gmail_create_draft", {
      to: ["sam@example.com"],
      subject: "Unsafe attachment",
      body: "This must not download.",
      attachments: [{ url: "http://169.254.169.254/latest/meta-data" }],
    }, {})).rejects.toThrow("Attachment url must be a public https URL");
    expect(attachmentRequests).toHaveLength(1);

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
  } finally {
    setGmailAttachmentFetchForTests();
    globalThis.fetch = previousFetch;
    restoreEnv("OPENWORK_DEV_MODE", previousEnv.devMode);
    restoreEnv("OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", previousEnv.plaintextVault);
    restoreEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", previousEnv.clientSecret);
    await rm(root, { recursive: true, force: true });
  }
});
