import type { OpenworkServerClient } from "../../../../app/lib/openwork-server";
import { readOpenworkEnvPendingChanges } from "../../../../app/lib/openwork-env-runtime";

const MAX_ENV_KEYS_IN_CONTEXT = 80;

function normalizeEnvKeys(keys: string[]): string[] {
  return Array.from(
    new Set(
      keys
        .map((key) => key.trim())
        .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

export async function buildOpenworkEnvSystemContext(
  client: OpenworkServerClient | null,
): Promise<string | undefined> {
  if (!client) return undefined;
  if (readOpenworkEnvPendingChanges()) return undefined;

  try {
    const response = await client.listUserEnvKeys();
    const keys = normalizeEnvKeys(response.keys ?? []);
    if (keys.length === 0) return undefined;

    const visibleKeys = keys.slice(0, MAX_ENV_KEYS_IN_CONTEXT);
    const omittedCount = keys.length - visibleKeys.length;
    const keyList = visibleKeys.map((key) => `- ${key}`).join("\n");
    const omittedLine = omittedCount > 0 ? `\n- ...and ${omittedCount} more` : "";

    return [
      "OpenWork environment variables configured:",
      `${keyList}${omittedLine}`,
      "Only names are shown; values are secret. Use these names when relevant.",
    ].join("\n");
  } catch {
    return undefined;
  }
}
