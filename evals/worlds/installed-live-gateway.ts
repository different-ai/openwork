import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openworkConfigDir } from "../../packages/paths/index.mjs";
import { record } from "./engine-live-parity.ts";

/** Explicit opt-in: use a configured credential only at its original destination.
 * Never print, serialize as evidence, or pass this object to assertion failures. */
export async function installedLiveGateway() {
  if (process.env.OPENWORK_LIVE_INSTALLED_GATEWAY !== "1") return null;
  const db = new DatabaseSync(join(openworkConfigDir(), "runtime.sqlite"), { readOnly: true });
  let rows;
  try { rows = db.prepare("SELECT config_json FROM runtime_opencode_configs").all(); } finally { db.close(); }
  const auth: unknown = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8"));
  for (const row of rows) {
    if (typeof row.config_json !== "string") continue;
    const config: unknown = JSON.parse(row.config_json);
    if (!record(config) || !record(config.provider)) continue;
    for (const [id, provider] of Object.entries(config.provider)) {
      if (!record(provider) || provider.npm !== "@ai-sdk/openai" || !record(provider.options) || typeof provider.options.baseURL !== "string" || !record(provider.models)) continue;
      const url = new URL(provider.options.baseURL);
      if (url.origin !== "https://gateway.openworklabs.com" || url.username || url.password) continue;
      const credential = record(auth) ? auth[id] : null;
      if (!record(credential) || credential.type !== "api" || typeof credential.key !== "string") continue;
      const models = Object.entries(provider.models).slice(0, 2).flatMap(([modelId, model], index) => record(model) ? [{ id: modelId, config: { ...model, name: `Live model ${index === 0 ? "one" : "two"}` } }] : []);
      if (!models.length) continue;
      return { key: credential.key, baseURL: url.href, models };
    }
  }
  throw new Error("No configured OpenAI-compatible OpenWork Gateway credential is available");
}

/** CI supplies an explicitly selected real OpenAI provider; local runs may use
 * the installed Gateway. Credentials never become fixture evidence. */
export async function configuredLiveProvider() {
  if (process.env.OPENWORK_LIVE_INSTALLED_GATEWAY === "1") return installedLiveGateway();
  if (process.env.OPENWORK_LIVE_PROVIDER !== "OpenAI") return null;
  const keyName = process.env.OPENWORK_LIVE_KEY_ENV;
  const key = keyName ? process.env[keyName]?.trim() : undefined;
  const ids = (process.env.OPENWORK_LIVE_MODELS ?? process.env.OPENWORK_LIVE_MODEL)?.split(",").map(id => id.trim()).filter(Boolean);
  if (!key || !ids?.length) throw new Error("Live OpenAI requires a credential and OPENWORK_LIVE_MODELS; no mock fallback is allowed");
  return { key, baseURL: "https://api.openai.com/v1", models: ids.map((id, index) => ({ id, config: {
    id, name: `Live model ${index === 0 ? "one" : "two"}`, tool_call: true,
    limit: { context: 128_000, output: 16_384 },
  } })) };
}
