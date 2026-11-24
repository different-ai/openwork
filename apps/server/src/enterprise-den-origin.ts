import { desktopBootstrapPath } from "@openwork/paths";

import { readJsoncFile } from "./jsonc.js";

const MAX_BOOTSTRAP_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactEnterpriseOrigin(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") return null;
  const raw = rawValue.trim();
  if (!raw || raw.length > 2 * 1024) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function readActivatedEnterpriseDenOrigin(options?: {
  signal?: AbortSignal;
  path?: string;
}): Promise<string | null> {
  const path = options?.path ?? desktopBootstrapPath({ env: process.env });
  if (typeof path !== "string" || !path.trim()) return null;
  try {
    const { data, invalid } = await readJsoncFile<Record<string, unknown>>(
      path,
      {},
      {
        allowInvalid: true,
        maxBytes: MAX_BOOTSTRAP_BYTES,
        regularFileOnly: true,
        signal: options?.signal,
      },
    );
    if (invalid) return null;
    const activation = isRecord(data.enterpriseActivation) ? data.enterpriseActivation : null;
    if (!activation) return null;
    if (typeof activation.activatedAt !== "string" || !activation.activatedAt.trim()) return null;
    return exactEnterpriseOrigin(activation.denBaseUrl);
  } catch {
    options?.signal?.throwIfAborted();
    return null;
  }
}
