"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { getAddConnectorRoute, getMcpConnectionRoute, getMcpConnectionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GOOGLE_WORKSPACE_QUICK_ADD_ID, MICROSOFT_365_QUICK_ADD_ID, type NativeProviderKey } from "./connector-catalog";
import { useDenToast } from "./den-toast";
import {
  GOOGLE_WORKSPACE_DEFAULT_FEATURES,
  GOOGLE_WORKSPACE_PERMISSION_GROUPS,
  type NativePermissionGroup,
} from "./google-workspace-permissions";
import { ItemHeader, ItemPage, SectionTitle, StepFooter } from "./item-header";
import { DetailRows, ItemPanel } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { McpCredentialInput } from "./mcp-credential-input";
import { useCreateNativeProviderConnection, useGoogleApiCheck, useNativeProviderClient, useSaveNativeProviderClient } from "./mcp-connections-data";
import { MICROSOFT_365_DEFAULT_FEATURES, MICROSOFT_365_PERMISSION_GROUPS } from "./microsoft-365-permissions";

type ProviderCopy = {
  name: string;
  url: string;
  consoleLabel: string;
  consoleUrl: string;
  defaultFeatures: readonly string[];
  groups: readonly NativePermissionGroup[];
  tenant: boolean;
  clientIdPlaceholder: string;
  secretPlaceholder: string;
};

const PROVIDERS: Record<NativeProviderKey, ProviderCopy> = {
  [GOOGLE_WORKSPACE_QUICK_ADD_ID]: {
    name: "Google Workspace",
    url: "https://workspace.google.com",
    consoleLabel: "Open Google Cloud Console",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    defaultFeatures: GOOGLE_WORKSPACE_DEFAULT_FEATURES,
    groups: GOOGLE_WORKSPACE_PERMISSION_GROUPS,
    tenant: false,
    clientIdPlaceholder: "1234567890-abc.apps.googleusercontent.com",
    secretPlaceholder: "Client secret",
  },
  [MICROSOFT_365_QUICK_ADD_ID]: {
    name: "Microsoft 365",
    url: "https://www.microsoft.com/microsoft-365",
    consoleLabel: "Open Entra app registrations",
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    defaultFeatures: MICROSOFT_365_DEFAULT_FEATURES,
    groups: MICROSOFT_365_PERMISSION_GROUPS,
    tenant: true,
    clientIdPlaceholder: "Application (client) ID",
    secretPlaceholder: "Client secret value, not its ID",
  },
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

function permissionGroupName(feature: string) {
  return GOOGLE_WORKSPACE_PERMISSION_GROUPS.find((group) => group.permissions.some((permission) => permission.key === feature))?.name;
}

/** Each permission calls a Google API that must be turned on in the OAuth client's Cloud project. */
function GoogleApiStatus({ providerId, unsaved }: { providerId: string; unsaved: boolean }) {
  const check = useGoogleApiCheck(providerId);
  const off = check.data?.apis.filter((api) => api.status === "disabled").length ?? 0;
  return (
    <section className="flex flex-col gap-2.5" data-testid="google-api-check">
      <SectionTitle title="Google APIs" meta={check.data?.checked ? (off ? `${off} turned off` : "All on") : undefined} />
      <ItemPanel>
        <div className="flex items-start justify-between gap-4 px-5 py-3.5">
          <p className="text-[13px] leading-5 text-gray-600">
            Each permission needs its Google API turned on in the Google Cloud project that owns this OAuth client. The check uses your own sign-in on this connector{unsaved ? " and the saved permissions, not your unsaved changes" : ""}.
          </p>
          <DenButton size="sm" variant="secondary" loading={check.isFetching} onClick={() => void check.refetch()} data-testid="google-api-check-run">
            {check.data ? "Check again" : "Check APIs"}
          </DenButton>
        </div>
        {check.error ? <p className="border-t border-gray-100 px-5 py-3 text-[13px] text-red-600" role="alert">{check.error.message}</p> : null}
        {check.data && !check.data.checked ? (
          <p className="border-t border-gray-100 px-5 py-3 text-[13px] text-gray-600">Sign in to this connector with your Google account, then check again.</p>
        ) : null}
        {check.data?.apis.map((api) => (
          <div key={api.id} className="flex items-start justify-between gap-4 border-t border-gray-100 px-5 py-3" data-api={api.id} data-status={api.status}>
            <span className="flex flex-col">
              <span className="text-[13px] font-medium text-gray-900">{api.name}</span>
              <span className="text-[12px] leading-4 text-gray-500">
                {api.detail ?? `Needed for ${[...new Set(api.features.map(permissionGroupName).filter(Boolean))].join(", ")}`}
              </span>
            </span>
            {api.status === "disabled" && api.enableUrl ? (
              <a href={api.enableUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[13px] font-medium text-gray-900 underline">Turn on</a>
            ) : (
              <span className="shrink-0 text-[13px] text-gray-500">{api.status === "enabled" ? "On" : "Not checked"}</span>
            )}
          </div>
        ))}
      </ItemPanel>
    </section>
  );
}

/**
 * The org OAuth app and permissions for Google Workspace or Microsoft 365.
 * `create` adds a new Google Workspace connection; otherwise it saves the
 * client for `clientProviderId` (a connection id or the provider alias).
 */
export function NativeProviderSettings({ providerKey, clientProviderId, create, onSaved, footer }: {
  providerKey: NativeProviderKey;
  clientProviderId: string;
  create: boolean;
  onSaved: (connectionId: string, name: string) => void;
  footer: (input: { save: () => void; saving: boolean; disabled: boolean; label: string }) => ReactNode;
}) {
  const provider = PROVIDERS[providerKey];
  const clientConfig = useNativeProviderClient(clientProviderId, true);
  const createNative = useCreateNativeProviderConnection();
  const saveClient = useSaveNativeProviderClient();
  const [name, setName] = useState(provider.name);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [features, setFeatures] = useState<string[]>([...provider.defaultFeatures]);
  const [replacing, setReplacing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefilled = useRef(false);

  const creatingGoogle = create && providerKey === GOOGLE_WORKSPACE_QUICK_ADD_ID;
  const configured = !creatingGoogle && (clientConfig.data?.configured ?? false);

  useEffect(() => {
    if (!configured || prefilled.current || !clientConfig.data) return;
    prefilled.current = true;
    setFeatures(clientConfig.data.features);
  }, [clientConfig.data, configured]);

  const redirectUri = clientConfig.data?.redirectUri ?? "";
  const showCredentials = !clientConfig.isLoading && (!configured || replacing);
  const saving = createNative.isPending || saveClient.isPending;
  const credentialsIncomplete = showCredentials && (!clientId.trim() || !clientSecret.trim() || (provider.tenant && !tenantId.trim()));
  const disabled = clientConfig.isLoading || saving || credentialsIncomplete || (creatingGoogle && !name.trim());
  const label = configured && !replacing ? "Save permissions" : configured ? "Save new credentials" : `Add ${provider.name}`;

  function toggle(feature: string) {
    setFeatures((current) => current.includes(feature) ? current.filter((entry) => entry !== feature) : [...current, feature]);
  }

  async function copy() {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
    } catch {
      setError("Could not copy it. Select the address and copy it yourself.");
    }
  }

  async function save() {
    setError(null);
    const credentials = showCredentials
      ? { clientId: clientId.trim(), clientSecret: clientSecret.trim(), ...(provider.tenant ? { tenantId: tenantId.trim() } : {}) }
      : {};
    try {
      if (creatingGoogle) {
        const created = await createNative.mutateAsync({
          nativeProviderKey: providerKey,
          name: name.trim(),
          oauthClient: { clientId: clientId.trim(), clientSecret: clientSecret.trim(), features },
        });
        onSaved(created.id, created.name || name.trim());
        return;
      }
      await saveClient.mutateAsync({ providerId: clientProviderId, ...credentials, features });
      setReplacing(false);
      setClientSecret("");
      onSaved(clientProviderId, provider.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid={`native-provider-${providerKey}`}>
      {creatingGoogle ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Name" />
          <DenInput value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" placeholder={provider.name} />
        </section>
      ) : null}

      <section className="flex flex-col gap-2.5">
        <SectionTitle
          title="Redirect URI"
          meta={<a href={provider.consoleUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline">{provider.consoleLabel}</a>}
        />
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-mono text-[12px] text-gray-900" data-testid="native-provider-redirect-uri">
            {redirectUri || (clientConfig.error ? "The address did not load. Reload the page." : "Loading...")}
          </p>
          <DenButton variant="secondary" size="sm" disabled={!redirectUri} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</DenButton>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionTitle
          title="OAuth app"
          meta={configured && !replacing ? (
            <button type="button" className="font-medium text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline" onClick={() => {
              setClientId(clientConfig.data?.clientId ?? "");
              setTenantId(clientConfig.data?.tenantId ?? "");
              setClientSecret("");
              setReplacing(true);
            }}>Replace credentials</button>
          ) : replacing ? (
            <button type="button" className="font-medium text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline" onClick={() => setReplacing(false)}>Keep saved credentials</button>
          ) : undefined}
        />
        {clientConfig.isLoading ? <ItemPanel><p className="px-5 py-3 text-[13px] text-gray-500">Checking saved credentials...</p></ItemPanel> : null}
        {configured && !replacing ? (
          <DetailRows rows={[
            ...(provider.tenant ? [{ label: "Tenant ID", value: <span className="font-mono">{clientConfig.data?.tenantId ?? "Saved"}</span> }] : []),
            { label: "Client ID", value: <span className="font-mono">{clientConfig.data?.clientId ?? "Saved"}</span> },
            { label: "Client secret", value: "Saved" },
          ]} />
        ) : null}
        {showCredentials ? (
          <div className="flex flex-col gap-3">
            {provider.tenant ? (
              <Field label="Directory (tenant) ID">
                <McpCredentialInput kind="identifier" name={`${providerKey}-tenant-id`} data-testid="native-provider-tenant-id" value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
              </Field>
            ) : null}
            <Field label="Client ID">
              <McpCredentialInput kind="identifier" name={`${providerKey}-oauth-client-id`} data-testid="native-provider-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder={provider.clientIdPlaceholder} />
            </Field>
            <Field label="Client secret">
              <McpCredentialInput kind="secret" name={`${providerKey}-oauth-client-secret`} data-testid="native-provider-client-secret" value={clientSecret} onChange={setClientSecret} placeholder={provider.secretPlaceholder} />
            </Field>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionTitle title="What your AI can do" meta={`${features.length} on`} />
        <ItemPanel>
          {provider.groups.map((group) => (
            <fieldset key={group.name} className="flex flex-col gap-2 px-5 py-3.5">
              <legend className="sr-only">{group.name}</legend>
              <p className="text-[13px] font-medium text-gray-900" aria-hidden>{group.name}</p>
              {group.permissions.map((permission) => (
                <label key={permission.key} className="flex items-start gap-2.5 text-[13px] leading-5 text-gray-700">
                  <input
                    type="checkbox"
                    data-feature={permission.key}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900"
                    checked={features.includes(permission.key)}
                    disabled={clientConfig.isLoading || saving}
                    onChange={() => toggle(permission.key)}
                  />
                  <span className="flex flex-col">
                    <span>{permission.label}</span>
                    {permission.detail ? <span className="text-[12px] leading-4 text-gray-500">{permission.detail}</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </ItemPanel>
      </section>

      {providerKey === GOOGLE_WORKSPACE_QUICK_ADD_ID && configured && !replacing ? (
        <GoogleApiStatus
          providerId={clientProviderId}
          unsaved={[...features].sort().join() !== [...(clientConfig.data?.features ?? [])].sort().join()}
        />
      ) : null}

      {error ? <p className="text-[13px] text-red-600" role="alert">{error}</p> : null}
      {footer({ save: () => void save(), saving, disabled, label })}
    </div>
  );
}

/** Add Google Workspace or Microsoft 365 as a full page: one OAuth app, then each person signs in. */
export function NativeProviderSetupScreen({ providerKey }: { providerKey: NativeProviderKey }) {
  const router = useRouter();
  const toast = useDenToast();
  const { orgSlug } = useOrgDashboard();
  const provider = PROVIDERS[providerKey];
  return (
    <ItemPage testId="connector-setup">
      <ItemHeader
        back={{ href: getAddConnectorRoute(orgSlug), label: "Add a connector" }}
        logo={<ConnectorLogo name={provider.name} url={provider.url} size="md" />}
        title={`Add ${provider.name}`}
      />
      <NativeProviderSettings
        providerKey={providerKey}
        clientProviderId={providerKey}
        create
        onSaved={(connectionId, name) => {
          toast({ title: `${name} is ready`, description: "Each person signs in with their own account." });
          router.push(getMcpConnectionRoute(orgSlug, connectionId));
        }}
        footer={({ save, saving, disabled, label }) => (
          <StepFooter note="Each person signs in with their own account">
            <DenButton variant="secondary" disabled={saving} onClick={() => router.push(getMcpConnectionsRoute(orgSlug))}>Cancel</DenButton>
            <DenButton loading={saving} disabled={disabled} onClick={save} data-testid="native-provider-save">{label}</DenButton>
          </StepFooter>
        )}
      />
    </ItemPage>
  );
}
