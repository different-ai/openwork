"use client";

import { useEffect, useState } from "react";
import { useDenFlow } from "../_providers/den-flow-provider";

type InstallationProvider = { id: `env-oidc-${string}`; name: string };

function isInstallationProvider(value: unknown): value is InstallationProvider {
  if (!value || typeof value !== "object") return false;
  const id: unknown = Object.getOwnPropertyDescriptor(value, "id")?.value;
  const name: unknown = Object.getOwnPropertyDescriptor(value, "name")?.value;
  return typeof id === "string" && /^env-oidc-[a-z][a-z0-9-]{0,47}$/.test(id)
    && typeof name === "string" && name.length > 0 && name.length <= 80;
}

/** The API, not browser environment variables, is authoritative for availability.
 * Organization SSO keeps precedence; this does not replace its login route.
 */
export function EnvironmentOidcButton() {
  const { beginSocialAuth, runtimeConfigLoaded, authBusy, desktopRedirectBusy } = useDenFlow();
  const [provider, setProvider] = useState<InstallationProvider | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/den/v1/auth/environment-oidc", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const payload: unknown = await response.json();
        const value: unknown = payload && typeof payload === "object" ? Object.getOwnPropertyDescriptor(payload, "provider")?.value : null;
        if (isInstallationProvider(value)) setProvider(value);
      }).catch(() => { /* Existing sign-in methods remain available on failure. */ });
    return () => controller.abort();
  }, []);
  if (!provider) return null;
  return (
    <button
      type="button"
      className="den-button-secondary den-social-button"
      disabled={!runtimeConfigLoaded || authBusy || desktopRedirectBusy}
      onClick={() => void beginSocialAuth(provider.id)}
    >
      Continue with {provider.name}
    </button>
  );
}
