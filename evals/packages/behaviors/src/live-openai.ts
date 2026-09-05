import { denFetch, type DenSession } from "./den.ts";

export const liveOpenAiEnabled = () => process.env.OPENWORK_EVAL_LIVE_OPENAI === "1";
export const liveOpenAiModel = () => process.env.OPENWORK_EVAL_OPENAI_MODEL?.trim() || "gpt-4.1-mini";

export function assertNoLiveSecret(value: unknown): void {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key && JSON.stringify(value)?.includes(key)) throw new Error("Live credential appeared in a public response (value suppressed)");
}

/** Provision via Den's authenticated API; never put the key in a CDP expression. */
export async function provisionLiveOpenAi(admin: DenSession, organizationName: string) {
  const empty = { id: "", async [Symbol.asyncDispose]() {} };
  if (!liveOpenAiEnabled()) return empty;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("Live OpenAI requires OPENAI_API_KEY");
  const headers = { authorization: `Bearer ${admin.token}` };
  const orgs = await denFetch(admin, "/v1/me/orgs", { headers });
  const body = orgs.body;
  const org = typeof body === "object" && body !== null && "orgs" in body && Array.isArray(body.orgs) ? body.orgs.find((entry) => record(entry) && entry.name === organizationName) : null;
  if (!org || typeof org.id !== "string") throw new Error("Live provider needs an isolated organization");
  const orgHeaders = { ...headers, "x-openwork-org-id": org.id };
  let result;
  try {
    result = await denFetch(admin, "/v1/llm-providers", { method: "POST", headers: orgHeaders,
      body: JSON.stringify({ name: "Live OpenAI reload proof", source: "models_dev", providerId: "openai",
        modelIds: [liveOpenAiModel()], apiKey: key, allMembers: true, memberIds: [], teamIds: [] }) });
  } catch { throw new Error("Live provider provisioning failed (details suppressed)"); }
  assertNoLiveSecret(result.body);
  const provider = typeof result.body === "object" && result.body !== null && "llmProvider" in result.body ? result.body.llmProvider : null;
  if (result.response.status !== 201 || typeof provider !== "object" || provider === null || !("id" in provider) || typeof provider.id !== "string") {
    throw new Error(`Live provider provisioning returned HTTP ${result.response.status}`);
  }
  const id = provider.id;
  return { id, async [Symbol.asyncDispose]() {
    const deleted = await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(id)}`, { method: "DELETE", headers: orgHeaders });
    if (!deleted.response.ok) throw new Error(`Live provider cleanup returned HTTP ${deleted.response.status}`);
  } };
}

type Request = (path: string, method?: string, body?: unknown) => Promise<{status: number; json: unknown}>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function liveProviderId(request: Request, cloudId: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  do {
    const result = await request("/cloud-provider-sync/status");
    assertNoLiveSecret(result.json);
    const entries = record(result.json) && Array.isArray(result.json.providers) ? result.json.providers : [];
    const provider = entries.find((entry) => record(entry) && entry.cloudProviderId === cloudId);
    if (record(provider) && typeof provider.providerId === "string") return provider.providerId;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error("Managed live OpenAI provider did not reach the desktop");
}

/** Observe a fresh completed assistant response, never match historical text. */
export async function liveV2Turn(request: Request, v2: string, sessionId: string, prompt: string) {
  const path = `${v2}/api/session/${sessionId}`;
  const before = (await request(`${path}/message`)).json;
  const oldIds = new Set(record(before) && Array.isArray(before.data) ? before.data.filter(record).map((message) => message.id) : []);
  const sinceIso = new Date().toISOString();
  if ((await request(`${path}/prompt`, "POST", { text: prompt })).status !== 200) throw new Error("Live v2 prompt was not admitted");
  const deadline = Date.now() + 120_000;
  do {
    const permissions = (await request(`${path}/permission`)).json;
    if (record(permissions) && Array.isArray(permissions.data)) for (const permission of permissions.data) {
      if (record(permission) && typeof permission.id === "string") {
        const relevant = permission.action === "skill" || permission.action === "reload-witness_read_report"
          || permission.action === "openwork-cloud_search_capabilities";
        const allowed = await request(`${path}/permission/${permission.id}/reply`, "POST", { reply: relevant ? "once" : "reject" });
        if (![200, 204].includes(allowed.status)) throw new Error("Live tool permission could not be approved");
      }
    }
    const result = (await request(`${path}/message`)).json;
    assertNoLiveSecret(result);
    const messages = record(result) && Array.isArray(result.data) ? result.data.filter(record).filter((message) => message.type === "assistant" && !oldIds.has(message.id)) : [];
    if (messages.length > 16) {
      await request(`${path}/interrupt`, "POST", {});
      throw new Error("Live model exceeded the bounded tool-call budget");
    }
    if (messages.some((message) => message.error || message.finish === "error")) throw new Error("Live model request failed (inspect redacted engine status)");
    const completed = messages.find((message) => record(message.time) && typeof message.time.completed === "number" && message.finish === "stop");
    if (completed) {
      const text = Array.isArray(completed.content) ? completed.content.filter(record).filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
      if (!text) throw new Error("Live model returned no final text");
      return { text, messages: JSON.stringify(messages), sinceIso };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error("Live model did not finish within 120 seconds");
}
