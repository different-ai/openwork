import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { startMockGoogle } from "@openwork/labs";
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import type { MockGoogleHandle } from "@openwork/labs";

/**
 * CLAIMS:
 *  - The registered cloud-upload actions accept workspace paths, never inline
 *    bytes/base64, and the model-callable Gmail JSON capability has no
 *    attachments field.
 *  - A real binary workspace file crosses the local extension, authenticated
 *    Den multipart route, and mock Drive/Gmail APIs byte-for-byte intact.
 *  - Gmail returns only attachment metadata to the model-visible caller.
 *  - Aggregate input above 4 MiB is rejected in the local extension before its
 *    fetch dependency is called.
 *
 * This is a stack spec because it cold-boots a real Den. It deliberately does
 * not drive Electron: the observable product boundary for this transport is
 * the extension action call plus the provider witness, not UI presentation.
 */

const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !localPlacement
  ? "google workspace direct uploads skipped — needs: local placement without OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "google workspace direct uploads skipped — needs: MySQL on 127.0.0.1:3306"
    : "workspace paths upload directly to Google without model-visible bytes";
const cloudUploadRunner = fileURLToPath(new URL("../packages/labs/bin/cloud-upload-runner.mjs", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string.`);
  return value;
}

function topLevelPropertyNames(schema: unknown): string[] {
  const record = requireRecord(schema, "JSON schema");
  const properties = requireRecord(record.properties, "JSON schema properties");
  return Object.keys(properties).sort();
}

function resolveLocalSchema(document: unknown, schema: unknown): unknown {
  let current = schema;
  const visited = new Set<string>();
  while (isRecord(current) && typeof current.$ref === "string" && current.$ref.startsWith("#/")) {
    if (visited.has(current.$ref)) throw new Error(`OpenAPI schema reference loop: ${current.$ref}`);
    visited.add(current.$ref);
    let resolved: unknown = document;
    for (const segment of current.$ref.slice(2).split("/")) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      resolved = isRecord(resolved) ? resolved[key] : undefined;
    }
    current = resolved;
  }
  return current;
}

function openApiRequestSchema(document: unknown, path: string): unknown {
  const root = requireRecord(document, "OpenAPI document");
  const paths = requireRecord(root.paths, "OpenAPI paths");
  const operation = requireRecord(requireRecord(paths[path], `${path} path`).post, `${path} POST operation`);
  const requestBody = requireRecord(operation.requestBody, `${path} request body`);
  const content = requireRecord(requestBody.content, `${path} request content`);
  return requireRecord(content["application/json"], `${path} application/json content`).schema;
}

function payloadFieldNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(payloadFieldNames);
  if (!isRecord(value)) return [];
  return [
    ...Object.keys(value),
    ...Object.values(value).flatMap(payloadFieldNames),
  ];
}

function googleEnvironment(google: MockGoogleHandle): Record<string, string> {
  return {
    DEN_GOOGLE_API_BASE_URL: google.apiUrl,
    DEN_GOOGLE_OAUTH_AUTHORIZE_URL: google.authorizeUrl,
    DEN_GOOGLE_OAUTH_TOKEN_URL: google.tokenUrl,
    DEN_GOOGLE_OAUTH_USERINFO_URL: google.userinfoUrl,
  };
}

function installEnvironment(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function connectGoogle(session: DenSession, google: MockGoogleHandle, email: string): Promise<void> {
  const configured = await denFetch(session, "/v1/oauth-providers/google-workspace/client", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      clientId: "direct-upload-spec-client",
      clientSecret: "direct-upload-spec-secret",
      features: ["gmailDraft", "driveFile"],
    }),
  });
  if (!configured.response.ok) {
    throw new Error(`Google client setup failed: HTTP ${configured.response.status} ${configured.text.slice(0, 500)}`);
  }

  const started = await denFetch(session, "/v1/oauth-providers/google-workspace/connect/start", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const authorizeUrl = isRecord(started.body) ? requireString(started.body.authorizeUrl, "Google authorize URL") : "";
  if (!started.response.ok) {
    throw new Error(`Google connect start failed: HTTP ${started.response.status} ${started.text.slice(0, 500)}`);
  }
  const chooser = await fetch(authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  expect(chooser.status).toBe(200);
  await google.chooseAccount(email, { timeoutMs: 10_000 });

  const status = await denFetch(session, "/v1/oauth-providers/google-workspace/status", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  expect(status.response.status).toBe(200);
  expect(isRecord(status.body) && status.body.connected === true).toBe(true);
  expect(isRecord(status.body) ? status.body.externalAccountId : null).toBe(email);
}

async function mintWriteToken(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ scopes: ["mcp:write"] }),
  });
  const token = isRecord(result.body) ? requireString(result.body.token, "MCP write token") : "";
  if (!result.response.ok) throw new Error(`MCP token mint failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  return token;
}

function runCloudUpload(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [cloudUploadRunner], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Cloud upload Bun runner timed out after 30 seconds."));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        reject(new Error(`Cloud upload Bun runner exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 1_000)}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(output);
        resolve(requireRecord(parsed, "Cloud upload Bun runner result"));
      } catch (error) {
        reject(new Error(`Cloud upload Bun runner returned invalid JSON: ${output.slice(0, 1_000)}; ${String(error)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test.skipIf(!localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({});
  const account = "uploader@openwork.test";
  const root = await mkdtemp(join(tmpdir(), "openwork-direct-upload-spec-"));
  const fixture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x13]);
  await writeFile(join(root, "witness.png"), fixture);
  await using google = await startMockGoogle({ accounts: [account], port: 0, autoApprove: false });
  const restoreEnvironment = installEnvironment(googleEnvironment(google));

  try {
    await using den = await server({ place });
    await connectGoogle(den.admin, google, account);
    const mcpToken = await mintWriteToken(den.admin);

    const inspection = await runCloudUpload({ mode: "inspect" });
    const actions = Array.isArray(inspection.result) ? inspection.result : [];
    const cloudActions = actions.filter((action): action is Record<string, unknown> => (
      isRecord(action) && action.extensionId === "openwork-cloud-uploads"
    ));
    expect(cloudActions.map((action) => action.action).sort()).toEqual([
      "drive_upload_file",
      "gmail_create_draft_with_attachments",
    ]);
    const driveAction = cloudActions.find((action) => action.action === "drive_upload_file");
    const gmailAction = cloudActions.find((action) => action.action === "gmail_create_draft_with_attachments");
    const driveInputFields = topLevelPropertyNames(driveAction?.inputSchema);
    const gmailInputFields = topLevelPropertyNames(gmailAction?.inputSchema);
    const extensionByteFields = [...driveInputFields, ...gmailInputFields].filter((field) => /base64|bytes/i.test(field));
    expect(driveInputFields).toEqual(["folderId", "path"]);
    expect(gmailInputFields).toEqual(["bcc", "body", "cc", "paths", "subject", "threadId", "to"]);
    expect(extensionByteFields).toEqual([]);

    const openApiResponse = await fetch(`${den.ref.apiUrl}/openapi.json`, { signal: AbortSignal.timeout(10_000) });
    expect(openApiResponse.status).toBe(200);
    const openApiDocument: unknown = await openApiResponse.json();
    const draftSchema = resolveLocalSchema(
      openApiDocument,
      openApiRequestSchema(openApiDocument, "/v1/capabilities/google-workspace/gmail-drafts"),
    );
    const jsonDraftFields = topLevelPropertyNames(draftSchema);
    expect(jsonDraftFields).not.toContain("attachments");
    evidence.fact(
      "Cloud upload inputs expose paths, not bytes",
      "Both registered extension schemas contain only path and message metadata fields; the Den Gmail JSON schema has no attachments field.",
      extensionByteFields.length === 0 && !jsonDraftFields.includes("attachments"),
    );

    const driveSince = new Date().toISOString();
    const driveRun = await runCloudUpload({
      mode: "call",
      root,
      action: "drive_upload_file",
      args: { path: "witness.png" },
      context: { directory: root },
      cloudUrl: `${den.ref.apiUrl}/mcp/agent`,
      mcpToken,
    });
    expect(driveRun.ok).toBe(true);
    expect(driveRun.networkCalls).toBe(1);
    const driveResult = driveRun.result;
    const driveUploads = await google.driveUploadsFor(account, { since: driveSince, atLeast: 1, timeoutMs: 10_000 });
    const driveUpload = driveUploads[0];
    expect(driveUpload?.filename).toBe("witness.png");
    expect(driveUpload?.mimeType).toBe("image/png");
    expect(driveUpload?.content).toEqual(fixture);
    expect(requireRecord(requireRecord(driveResult, "Drive action result").file, "Drive result file")).toMatchObject({
      name: "witness.png",
      mimeType: "image/png",
      size: String(fixture.byteLength),
    });
    evidence.fact(
      "Drive receives the exact authorized workspace file",
      `Mock Drive observed witness.png as image/png with ${driveUpload?.content.toString("hex")} bytes.`,
      driveUpload?.content.equals(fixture) === true,
    );

    const draftSince = new Date().toISOString();
    const draftRun = await runCloudUpload({
      mode: "call",
      root,
      action: "gmail_create_draft_with_attachments",
      args: {
        to: "reviewer@openwork.test",
        subject: "Binary attachment witness",
        body: "Please review the attached file.",
        paths: ["witness.png"],
      },
      context: { directory: root },
      cloudUrl: `${den.ref.apiUrl}/mcp/agent`,
      mcpToken,
    });
    expect(draftRun.ok).toBe(true);
    expect(draftRun.networkCalls).toBe(1);
    const draftResult = draftRun.result;
    const drafts = await google.draftsFor(account, { since: draftSince, atLeast: 1, timeoutMs: 10_000 });
    const attachment = drafts[0]?.attachments?.[0];
    expect(attachment?.filename).toBe("witness.png");
    expect(attachment?.mimeType).toBe("image/png");
    expect(attachment?.content).toEqual(fixture);
    const resultAttachments = requireRecord(draftResult, "Gmail action result").attachments;
    expect(resultAttachments).toEqual([{
      filename: "witness.png",
      mimeType: "image/png",
      size: fixture.byteLength,
    }]);
    const forbiddenResultFields = payloadFieldNames(draftResult).filter((name) => /base64|bytes|content|raw/i.test(name));
    expect(forbiddenResultFields).toEqual([]);
    expect(JSON.stringify(draftResult)).not.toContain(fixture.toString("base64"));
    evidence.fact(
      "Gmail receives exact attachment bytes while the action returns metadata only",
      `Mock Gmail observed ${attachment?.filename}/${attachment?.mimeType}/${attachment?.size}; result fields were ${payloadFieldNames(draftResult).join(", ")}.`,
      attachment?.content.equals(fixture) === true && forbiddenResultFields.length === 0,
    );

    await writeFile(join(root, "part-a.bin"), Buffer.alloc((2 * 1024 * 1024) + 1, 0xa5));
    await writeFile(join(root, "part-b.bin"), Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const oversizeRun = await runCloudUpload({
      mode: "call",
      root,
      action: "gmail_create_draft_with_attachments",
      args: {
        to: "reviewer@openwork.test",
        subject: "Too large",
        body: "This must fail locally.",
        paths: ["part-a.bin", "part-b.bin"],
      },
      context: { directory: root },
      cloudUrl: `${den.ref.apiUrl}/mcp/agent`,
      mcpToken,
    });
    expect(oversizeRun).toMatchObject({ ok: false, status: 413, code: "files_too_large", networkCalls: 0 });
    evidence.fact(
      "Oversize aggregate input is rejected before network I/O",
      `The extension fetch call count was ${oversizeRun.networkCalls}.`,
      oversizeRun.networkCalls === 0,
    );
  } finally {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  }
});
