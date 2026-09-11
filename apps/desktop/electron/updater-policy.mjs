const POLICY_UNAVAILABLE = "Sign in and connect to verify your organization's update policy.";

export const UNMANAGED_UPDATER_POLICY = Object.freeze({ verification: "unmanaged", identity: null, policy: null });

export function parseUpdaterPolicySnapshot(payload, { requireManaged = false } = {}) {
  if (!requireManaged && payload?.verification === "unmanaged" && payload.policy === null && payload.identity === null) {
    return UNMANAGED_UPDATER_POLICY;
  }
  const policy = payload?.policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
    || !["fresh", "cached-offline"].includes(payload.verification)
    || typeof payload.identity !== "string" || !payload.identity.trim() || payload.identity.length > 128
    || (policy.allowedDesktopVersions !== undefined && (!Array.isArray(policy.allowedDesktopVersions)
      || policy.allowedDesktopVersions.some(version => typeof version !== "string")))
    || (policy.allowAlphaUpdates !== undefined && typeof policy.allowAlphaUpdates !== "boolean")) {
    throw new Error(POLICY_UNAVAILABLE);
  }
  return { policy, identity: payload.identity, verification: payload.verification };
}

/** Read only main-owned runtime credentials; never accept policy over updater IPC. */
export async function readRequiredUpdaterPolicy({ requiresPolicy, getServerInfo, fetchPolicy = fetch }) {
  // Packaging alone cannot distinguish unmanaged public installs from public
  // builds signed in to an organization. The local authority knows that state;
  // its unmanaged response does not require a Den request or sign-in.
  const info = getServerInfo();
  const token = info?.clientToken ?? info?.ownerToken;
  if (!info?.running || !info.baseUrl || !token) throw new Error(POLICY_UNAVAILABLE);
  let payload;
  try {
    const response = await fetchPolicy(`${info.baseUrl.replace(/\/+$/, "")}/managed-policy/updater`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(POLICY_UNAVAILABLE);
    payload = await response.json();
  } catch {
    // Do not confuse failed authentication/verification with unrestricted {}.
    // Do not expose service response bodies or runtime credentials in errors.
    throw new Error(POLICY_UNAVAILABLE);
  }
  return parseUpdaterPolicySnapshot(payload, { requireManaged: requiresPolicy() });
}
