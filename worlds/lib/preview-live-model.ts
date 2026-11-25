import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const defaultPreviewModelId = "openai/gpt-6-luna";

async function vercelApi(args: string[], body?: object) {
  const call = exec("vercel", ["api", ...args, "--raw", "--non-interactive", ...(body ? ["--input", "-"] : [])], { timeout: 30_000 });
  call.child.stdin?.end(body ? JSON.stringify(body) : undefined);
  // execFile errors include captured output. A key creation response is secret.
  try { return (await call).stdout; }
  catch { throw new Error("Vercel AI Gateway key management failed. Check the runner's Vercel login and development team permissions."); }
}

export async function installLiveModel(stack: AsyncDisposableStack, input: {
  team: string; modelId?: string; expiresAt: string; origin: string; headers: Record<string, string>; token: string; hostToken: string;
}, api = vercelApi, request = fetch) {
  const { team, token, hostToken } = input;
  const previewModel = { providerID: "preview-live", modelID: input.modelId ?? defaultPreviewModelId };
  const origin = new URL(input.origin);
  const expiresAt = Date.parse(input.expiresAt);
  if (!/^team_[A-Za-z0-9]+$/.test(team) || origin.protocol !== "https:" || !token || !hostToken ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 24 * 60 * 60_000) {
    throw new Error("Live model needs an owned private preview, an expiry and a development Vercel team.");
  }
  async function runtime(path: string, method: string, headers: Record<string, string>, body?: object) {
    const response = await request(new URL("/api/openwork" + path, origin), { method, redirect: "error",
      headers: { ...input.headers, ...headers, "content-type": "application/json" },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Live model setup ${method} ${path} returned HTTP ${response.status}.`);
    return response;
  }
  const auth = { authorization: `Bearer ${token}` };
  const workspaces = await (await runtime("/workspaces", "GET", auth)).json();
  const workspaceId = workspaces.items?.[0]?.id;
  if (typeof workspaceId !== "string" || !workspaceId) throw new Error("Live model preview is missing its initial workspace.");
  const query = `?teamId=${team}`;
  const result = JSON.parse(await api([`/v1/api-keys${query}`, "-X", "POST"], {
    name: `openwork-preview-${randomUUID()}`, purpose: "ai-gateway", expiresAt,
    aiGatewayQuota: { limitAmount: 1, includeByokInQuota: true },
  }));
  const id = result.apiKey?.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Vercel did not return a preview key ID.");
  stack.defer(async () => {
    await api([`/v1/api-keys/${id}${query}`, "-X", "DELETE", "--dangerously-skip-permissions"]);
  });
  if (typeof result.apiKeyString !== "string" || !result.apiKeyString) throw new Error("Vercel did not issue a preview credential.");
  const provider = { [previewModel.providerID]: { name: "Preview live model", npm: previewModel.modelID.startsWith("openai/") ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
    options: { baseURL: "https://ai-gateway.vercel.sh/v1", apiKey: result.apiKeyString },
    models: { [previewModel.modelID]: { name: `${previewModel.modelID} (development)` } } } };
  const patched = await runtime("/runtime-config/providers", "PATCH", { "x-openwork-host-token": hostToken }, { provider });
  await patched.body?.cancel();
  await (await runtime(`/workspace/${encodeURIComponent(workspaceId)}/default-model`, "PUT", auth, { model: previewModel })).body?.cancel();
  return { liveModel: `${previewModel.providerID}/${previewModel.modelID}`, liveModelKeyId: id };
}
