import { desktopBootstrapPath } from "@openwork/paths";

import { readJsoncFile } from "./jsonc.js";

const MAX_BOOTSTRAP_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduces an administrator-provisioned Den control-plane URL to its exact
 * origin. Anything carrying credentials, a query, or a fragment is rejected
 * rather than trimmed, so a malformed activation record can never widen the
 * diagnostics trust list.
 */
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

/**
 * Resolves the origin of the enterprise/on-prem Den control plane this
 * installation is already activated against.
 *
 * The desktop writes `enterpriseActivation` only after a signed connect-link
 * activation claim verifies, so it is administrator-provisioned configuration
 * rather than a renderer- or request-supplied URL — the one non-built-in
 * source the credentialed diagnostics probe may trust without an explicit
 * environment override. A missing, unreadable, or malformed record yields
 * null and the probe stays fail-closed.
 */
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
    // Both fields are required by the desktop writer; an entry without a
    // completed activation timestamp is not proof of a provisioned tenant.
    if (typeof activation.activatedAt !== "string" || !activation.activatedAt.trim()) return null;
    return exactEnterpriseOrigin(activation.denBaseUrl);
  } catch {
    options?.signal?.throwIfAborted();
    return null;
  }
}
