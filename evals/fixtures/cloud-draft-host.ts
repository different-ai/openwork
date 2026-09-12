import { fileURLToPath } from "node:url";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "../../packages/world/src/headless-web.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid draft host setup object");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Missing draft host setup field");
  return value;
}

export async function reconcileDraftHost(value: unknown) {
  const input = record(value);
  const name = text(input.name);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid owned runtime name");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const paths = resolveHeadlessWorldRuntimePaths(root, name);
  const runtime = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!runtime || runtime.openworkUrl !== input.openworkUrl || runtime.workspace !== input.workspaceRoot) {
    throw new Error("Draft fixture could not identify its owned headless runtime");
  }
  const token = text(input.token);
  const appHostToken = text(input.appHostToken);
  const response = await fetch(`${runtime.openworkUrl}/workspace/${encodeURIComponent(text(input.workspaceId))}/mcp/openwork-cloud/reconcile`, {
    method: "POST",
    headers: { "X-OpenWork-Host-Token": runtime.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { type: "remote", url: text(input.cloudUrl), enabled: true, headers: { Authorization: `Bearer ${token}` }, oauth: false },
      appHostAuthorization: `Bearer ${appHostToken}`, trigger: "draft-routing-world",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try { body = record(JSON.parse(raw)); } catch {}
  const sanitize = (value: unknown) => typeof value === "string"
    ? [runtime.hostToken, runtime.token, token, appHostToken].filter(Boolean).reduce((result, secret) => result.replaceAll(secret, "[redacted]"), value)
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400)
    : null;
  const details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? record(body.details) : {};
  return {
    status: response.status, phase: sanitize(body.phase), diagnostic: sanitize(body.connectCatalogDiagnostic),
    error: sanitize(body.error), message: sanitize(body.message),
    required: sanitize(details.required), scope: sanitize(details.scope),
    jsonBody: Object.keys(body).length > 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input: unknown = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
    console.log(JSON.stringify(await reconcileDraftHost(input)));
  } catch {
    console.error("Owned draft host setup failed before a sanitized response was available");
    process.exitCode = 1;
  }
}
