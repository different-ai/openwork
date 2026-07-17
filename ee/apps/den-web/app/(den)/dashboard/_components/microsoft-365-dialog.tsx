"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { useNativeProviderClient } from "./mcp-connections-data";
import {
  MICROSOFT_365_DEFAULT_FEATURES,
  MICROSOFT_365_PERMISSION_GROUPS,
} from "./microsoft-365-permissions";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Microsoft365Dialog({
  open,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: { clientId?: string; clientSecret?: string; tenantId?: string; features: string[] }) => void;
}) {
  const clientConfig = useNativeProviderClient("microsoft-365", open);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [features, setFeatures] = useState<string[]>([...MICROSOFT_365_DEFAULT_FEATURES]);
  const [copiedRedirectUri, setCopiedRedirectUri] = useState(false);
  const [replacingCredentials, setReplacingCredentials] = useState(false);
  const featuresPrefilled = useRef(false);

  useEffect(() => {
    if (!open) return;
    setClientId("");
    setClientSecret("");
    setTenantId("");
    setFeatures([...MICROSOFT_365_DEFAULT_FEATURES]);
    setCopiedRedirectUri(false);
    setReplacingCredentials(false);
    featuresPrefilled.current = false;
  }, [open]);

  useEffect(() => {
    if (!open || featuresPrefilled.current || !clientConfig.isSuccess || clientConfig.isFetching) return;
    setFeatures(clientConfig.data.features);
    featuresPrefilled.current = true;
  }, [open, clientConfig.isSuccess, clientConfig.isFetching, clientConfig.data?.features]);

  if (!open) return null;

  const configured = clientConfig.data?.configured ?? false;
  const savedClientId = clientConfig.data?.clientId;
  const savedTenantId = clientConfig.data?.tenantId;
  const redirectUri = clientConfig.data?.redirectUri ?? "";
  const loadingConfig = clientConfig.isLoading;
  const formError = error ?? clientConfig.error;
  const trimmedClientId = clientId.trim();
  const trimmedClientSecret = clientSecret.trim();
  const trimmedTenantId = tenantId.trim();
  const showCredentialFields = !loadingConfig && (!configured || replacingCredentials);
  const saveDisabled = loadingConfig || (showCredentialFields && (!trimmedClientId || !trimmedClientSecret || !trimmedTenantId));

  function toggleFeature(feature: string) {
    setFeatures((current) => current.includes(feature)
      ? current.filter((entry) => entry !== feature)
      : [...current, feature]);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        data-testid="microsoft-365-dialog"
        className="max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
          {configured ? "Update Microsoft 365" : "Set up Microsoft 365"}
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-600">
          Use one Entra web app for your organization. Each teammate then connects their own work account; OpenWork requests only the permissions your administrator enables below.
        </p>

        <div className="mt-5 space-y-4">
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-[13px] font-semibold text-gray-900">Set up the Entra app</p>
            <ol className="mt-2 list-decimal space-y-2 pl-4 text-[12px] leading-5 text-gray-600">
              <li>
                In Microsoft Entra admin center, create an app registration for accounts in your organization. {" "}
                <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener" className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-4">
                  Open app registrations
                </a>
              </li>
              <li>
                Add a Web platform and this exact redirect URI:
                <div className="mt-1 flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2">
                  <p data-microsoft-redirect-uri className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5 text-gray-800">
                    {redirectUri || "Loading redirect URI…"}
                  </p>
                  <DenButton
                    variant="secondary"
                    size="sm"
                    data-testid="copy-microsoft-redirect-uri"
                    disabled={!redirectUri}
                    onClick={async () => {
                      if (redirectUri && await copyText(redirectUri)) setCopiedRedirectUri(true);
                    }}
                  >
                    {copiedRedirectUri ? "Copied" : "Copy"}
                  </DenButton>
                </div>
              </li>
              <li>Add the delegated Microsoft Graph permissions shown below. Grant admin consent if your tenant policy requires it.</li>
              <li>Copy the Directory (tenant) ID, create a client secret, then paste all three values here.</li>
            </ol>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-[13px] font-semibold text-gray-900">Permissions</p>
            <p className="mt-1 text-[12px] leading-5 text-gray-500">
              Pick what your team&apos;s AI can do across Outlook, Calendar, OneDrive, and Teams. Signing in always shares the member&apos;s basic profile through User.Read.
            </p>
            <div className="mt-3 space-y-4">
              {MICROSOFT_365_PERMISSION_GROUPS.map((group) => (
                <div key={group.name}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">{group.name}</p>
                  <div className="space-y-2">
                    {group.permissions.map((permission) => (
                      <label key={permission.key} className="flex items-start gap-2 text-[13px] text-gray-700">
                        <input
                          type="checkbox"
                          data-feature={permission.key}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900"
                          checked={features.includes(permission.key)}
                          disabled={loadingConfig}
                          onChange={() => toggleFeature(permission.key)}
                        />
                        <span>
                          <span className="block">{permission.label}</span>
                          <span className="block font-mono text-[11px] text-gray-400">{permission.scope}</span>
                          {permission.detail ? <span className="mt-0.5 block text-[11px] leading-4 text-amber-700">{permission.detail}</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-[12px] leading-5 text-blue-800">
            Already using Entra OIDC SSO with a Web app registration you control? You can reuse that registration by adding this callback and the delegated Graph permissions. A SAML-only enterprise app may still need a separate app registration. SSO signs people into OpenWork; this separate consent grants only the Microsoft 365 capabilities selected above.
          </div>

          {loadingConfig ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4 text-[13px] text-gray-500">Checking saved credentials…</div>
          ) : null}

          {configured && !replacingCredentials ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-600" />
                <p className="text-[13px] font-semibold text-gray-900">Credentials saved</p>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-gray-500">Permission changes keep your encrypted client secret. Replace it only when rotating the Entra credential.</p>
              <div className="mt-3 rounded-xl border border-gray-100 bg-white px-3 py-2 text-[12px] text-gray-800">
                Saved client ID: <span className="font-mono">{savedClientId ?? "stored in OpenWork"}</span>
              </div>
              <div className="mt-2 rounded-xl border border-gray-100 bg-white px-3 py-2 text-[12px] text-gray-800">
                Tenant ID: <span className="font-mono">{savedTenantId ?? "stored in OpenWork"}</span>
              </div>
              <DenButton
                className="mt-3"
                variant="secondary"
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setClientId(savedClientId ?? "");
                  setClientSecret("");
                  setTenantId(savedTenantId ?? "");
                  setReplacingCredentials(true);
                }}
              >
                Change tenant or credentials
              </DenButton>
            </div>
          ) : null}

          {showCredentialFields ? (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-[13px] font-semibold text-gray-900">Entra OAuth credentials</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Directory (tenant) ID</label>
                  <DenInput data-testid="microsoft-tenant-id" value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Application (client) ID</label>
                  <DenInput value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-gray-700">Client secret value</label>
                  <DenInput type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="Paste the secret value, not its ID" />
                </div>
              </div>
              {replacingCredentials ? (
                <DenButton className="mt-3" variant="secondary" size="sm" disabled={submitting} onClick={() => setReplacingCredentials(false)}>
                  Keep saved credentials
                </DenButton>
              ) : null}
            </div>
          ) : null}
        </div>

        {formError ? (
          <DenNotice message={formError instanceof Error ? formError.message : "Failed to save the Microsoft 365 setup."} className="mt-3" />
        ) : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={submitting}>Cancel</DenButton>
          <DenButton
            variant="primary"
            loading={submitting}
            disabled={saveDisabled}
            data-testid="save-microsoft-365"
            onClick={() => onSubmit({
              ...(showCredentialFields ? { clientId: trimmedClientId, clientSecret: trimmedClientSecret, tenantId: trimmedTenantId } : {}),
              features,
            })}
          >
            {configured && !replacingCredentials ? "Save permissions" : replacingCredentials ? "Save new setup" : "Save setup"}
          </DenButton>
        </div>
      </div>
    </div>
  );
}
