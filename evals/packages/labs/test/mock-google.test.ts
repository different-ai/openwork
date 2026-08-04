import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { startMockGoogle } from "../src/mock-google.ts";
import type { MockGoogleHandle } from "../src/mock-google.ts";

interface CallbackLab {
  url: string;
  callbacks: URL[];
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

interface OAuthTokens {
  accessToken: string;
  idToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddressInfo(value: ReturnType<Server["address"]>): value is AddressInfo {
  return typeof value === "object"
    && value !== null
    && typeof value.address === "string"
    && typeof value.family === "string"
    && typeof value.port === "number";
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections();
  });
}

async function startCallbackLab(): Promise<CallbackLab> {
  const callbacks: URL[] = [];
  const server = createServer((request, response) => {
    callbacks.push(new URL(request.url ?? "/", "http://127.0.0.1"));
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("OAuth callback served");
  });
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const value = server.address();
      if (isAddressInfo(value)) {
        resolve(value);
        return;
      }
      reject(new Error("Callback lab did not expose a TCP port."));
    });
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await close(server);
  };
  return {
    url: `http://127.0.0.1:${address.port}/callback`,
    callbacks,
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

function tokenFingerprint(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 12);
}

async function authorize(
  google: MockGoogleHandle,
  callback: CallbackLab,
  email: string,
  clientId: string,
): Promise<OAuthTokens> {
  const verifier = `verifier-${clientId}`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(google.authorizeUrl);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", callback.url);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile https://www.googleapis.com/auth/gmail.compose");
  authorizeUrl.searchParams.set("state", `state-${clientId}`);
  authorizeUrl.searchParams.set("prompt", "consent select_account");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  const since = new Date().toISOString();
  const callbackCount = callback.callbacks.length;
  const chooser = await fetch(authorizeUrl, { redirect: "manual" });
  const chooserHtml = await chooser.text();

  assert.equal(chooser.status, 200);
  assert.match(chooserHtml, /Choose an account/);
  assert.match(chooserHtml, new RegExp(`data-account-email="${email.replaceAll(".", "\\.")}"`));
  const observed = await google.authorizeRequestSince(since, { timeoutMs: 2_000 });
  assert.equal(observed.params.get("prompt"), "consent select_account");
  await google.chooseAccount(email, { timeoutMs: 2_000 });
  assert.equal(callback.callbacks.length, callbackCount + 1, "chooseAccount must wait until the callback server receives the request");
  const callbackUrl = callback.callbacks.at(-1);
  const code = callbackUrl?.searchParams.get("code");
  assert.ok(code, "callback must carry an authorization code");

  const response = await fetch(google.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: `secret-${clientId}`,
      redirect_uri: callback.url,
    }),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, 200);
  assert.ok(isRecord(body));
  if (typeof body.access_token !== "string" || typeof body.id_token !== "string") {
    throw new Error(`Token response omitted access_token or id_token: ${JSON.stringify(body)}`);
  }
  return { accessToken: body.access_token, idToken: body.id_token };
}

function idTokenPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  assert.ok(payload, "id_token must have a JWT payload");
  const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.ok(isRecord(parsed));
  return parsed;
}

async function userinfo(google: MockGoogleHandle, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(google.userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  const body: unknown = await response.json();
  assert.equal(response.status, 200);
  assert.ok(isRecord(body));
  return body;
}

async function submitDraft(
  google: MockGoogleHandle,
  accessToken: string,
  message: string,
  threadId?: string,
): Promise<void> {
  const requestMessage: { raw: string; threadId?: string } = {
    raw: Buffer.from(message, "utf8").toString("base64url"),
  };
  if (threadId) requestMessage.threadId = threadId;
  const response = await fetch(`${google.apiUrl}/gmail/v1/users/me/drafts`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message: requestMessage }),
  });
  assert.equal(response.status, 200);
}

async function createDraft(
  google: MockGoogleHandle,
  accessToken: string,
  to: string,
  body: string,
  threadId?: string,
): Promise<void> {
  const message = [
    `To: ${to}`,
    "Subject: Fixture witness",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n");
  await submitDraft(google, accessToken, message, threadId);
}

test("mock Google issues independent account identities and credential fingerprints", async () => {
  const accountA = "jordan@acme.test";
  const accountB = "jordan@acmelabs.test";
  await using google = await startMockGoogle({ accounts: [accountA, accountB], port: 0, autoApprove: false });
  await using callback = await startCallbackLab();

  const tokensA = await authorize(google, callback, accountA, "client-a");
  const tokensB = await authorize(google, callback, accountB, "client-b");
  assert.notEqual(tokenFingerprint(tokensA.accessToken), tokenFingerprint(tokensB.accessToken));
  assert.equal(idTokenPayload(tokensA.idToken).email, accountA);
  assert.equal(idTokenPayload(tokensB.idToken).email, accountB);
  assert.equal((await userinfo(google, tokensA.accessToken)).email, accountA);
  assert.equal((await userinfo(google, tokensB.accessToken)).email, accountB);

  await createDraft(google, tokensA.accessToken, "archive@acme.test", "Account A", "thread-a");
  await createDraft(google, tokensB.accessToken, "archive@acmelabs.test", "Account B", "thread-b");
  const draftsA = await google.draftsFor(accountA);
  const draftsB = await google.draftsFor(accountB);
  assert.equal(draftsA[0]?.tokenId, tokenFingerprint(tokensA.accessToken));
  assert.equal(draftsB[0]?.tokenId, tokenFingerprint(tokensB.accessToken));
  assert.notEqual(draftsA[0]?.tokenId, draftsB[0]?.tokenId);
});

test("mock Google attributes drafts to one mailbox and returns an empty mailbox promptly", async () => {
  const accountA = "jordan@acme.test";
  const accountB = "jordan@acmelabs.test";
  await using google = await startMockGoogle({ accounts: [accountA, accountB], port: 0, autoApprove: false });
  await using callback = await startCallbackLab();
  const tokensA = await authorize(google, callback, accountA, "client-a");
  const since = new Date().toISOString();
  await createDraft(google, tokensA.accessToken, "supplier@parts.test", "Mailbox isolation witness", "thread-one");

  const draftsA = await google.draftsFor(accountA, { since, atLeast: 1, timeoutMs: 2_000 });
  const startedAt = Date.now();
  const draftsB = await google.draftsFor(accountB, { since, timeoutMs: 5_000 });
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(draftsB, []);
  assert.ok(elapsedMs < 1_000, `empty mailbox read blocked for ${elapsedMs}ms`);
  assert.equal(draftsA.length, 1);
  assert.deepEqual(draftsA[0], {
    to: "supplier@parts.test",
    body: "Mailbox isolation witness",
    threadId: "thread-one",
    tokenId: tokenFingerprint(tokensA.accessToken),
    at: draftsA[0]?.at,
  });
});

test("mock Google decodes text/plain nested inside mixed and alternative MIME", async () => {
  const account = "jordan@acme.test";
  await using google = await startMockGoogle({ accounts: [account], port: 0, autoApprove: false });
  await using callback = await startCallbackLab();
  const tokens = await authorize(google, callback, account, "client-nested-mime");
  const plainBody = "Nested multipart body marker";
  const mixedBoundary = "fixture-mixed";
  const alternativeBoundary = "fixture-alternative";
  const message = [
    "To: archive@acme.test",
    "Subject: Nested MIME witness",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(plainBody, "utf8").toString("base64"),
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(`<div>${plainBody}</div>`, "utf8").toString("base64"),
    `--${alternativeBoundary}--`,
    `--${mixedBoundary}`,
    'Content-Type: application/octet-stream; name="witness.bin"',
    'Content-Disposition: attachment; filename="witness.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("attachment bytes", "utf8").toString("base64"),
    `--${mixedBoundary}--`,
    "",
  ].join("\r\n");

  await submitDraft(google, tokens.accessToken, message);

  const drafts = await google.draftsFor(account);
  assert.equal(drafts[0]?.body, plainBody);
});

test("mock Google witnesses exact Gmail attachment and Drive upload bytes", async () => {
  const account = "jordan@acme.test";
  const fixture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x13, 0x0a]);
  await using google = await startMockGoogle({ accounts: [account], port: 0, autoApprove: false });
  await using callback = await startCallbackLab();
  const tokens = await authorize(google, callback, account, "client-binary-witness");

  const mixedBoundary = "fixture-mixed-binary";
  const message = [
    "To: archive@acme.test",
    "Subject: Binary witness",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Binary body", "utf8").toString("base64"),
    `--${mixedBoundary}`,
    'Content-Type: image/png; name="witness.png"',
    'Content-Disposition: attachment; filename="witness.png"',
    "Content-Transfer-Encoding: base64",
    "",
    fixture.toString("base64"),
    `--${mixedBoundary}--`,
    "",
  ].join("\r\n");
  await submitDraft(google, tokens.accessToken, message);
  const drafts = await google.draftsFor(account, { atLeast: 1, timeoutMs: 2_000 });
  assert.equal(drafts[0]?.attachments?.[0]?.filename, "witness.png");
  assert.equal(drafts[0]?.attachments?.[0]?.mimeType, "image/png");
  assert.deepEqual(drafts[0]?.attachments?.[0]?.content, fixture);

  const driveBoundary = "fixture-drive-binary";
  const metadata = Buffer.from(`--${driveBoundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"witness.png"}\r\n`, "utf8");
  const contentHeader = Buffer.from(`--${driveBoundary}\r\nContent-Type: image/png\r\n\r\n`, "utf8");
  const footer = Buffer.from(`\r\n--${driveBoundary}--\r\n`, "utf8");
  const uploadBody = Buffer.concat([metadata, contentHeader, fixture, footer]);
  const uploadBytes = new Uint8Array(uploadBody.byteLength);
  uploadBytes.set(uploadBody);
  const response = await fetch(`${google.apiUrl}/upload/drive/v3/files?uploadType=multipart`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": `multipart/related; boundary=${driveBoundary}`,
    },
    body: uploadBytes,
  });
  assert.equal(response.status, 200);
  const uploads = await google.driveUploadsFor(account, { atLeast: 1, timeoutMs: 2_000 });
  assert.equal(uploads[0]?.filename, "witness.png");
  assert.equal(uploads[0]?.mimeType, "image/png");
  assert.deepEqual(uploads[0]?.content, fixture);
});
