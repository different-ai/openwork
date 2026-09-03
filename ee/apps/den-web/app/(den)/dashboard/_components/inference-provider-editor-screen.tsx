"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { denApiEndpoint } from "../../_lib/den-api-origin";
import { getGatewayProviderRoute, getGatewayProvidersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { deleteInferenceProvider, saveInferenceProvider, useInferenceProvider } from "./inference-provider-data";
import {
  buildInferenceProviderRequestBody,
  getOauthCallbackPath,
  getRequiredSettingKeys,
  getSettingLabel,
  isGoogleVertexNpm,
  isSupportedGatewayNpm,
  supportsMemberCredentialMode,
  validateInferenceProviderForm,
  type DenInferenceProvider,
} from "./inference-provider-request";
import {
  getProviderDocUrl,
  getProviderEnvNames,
  getProviderIconSlug,
  getProviderNpmPackage,
  requestLlmProviderCatalog,
  requestLlmProviderCatalogDetail,
  type DenModelsDevProviderDetail,
  type DenModelsDevProviderSummary,
} from "./llm-provider-data";
import { normalizeAzureResourceNameInput } from "./llm-provider-guided";
import { buildCatalogProviderOptions, ProviderAccessPicker, ProviderModelPicker, type ProviderAccessValue } from "./llm-provider-pickers";
import { InferenceCredentialStatusBadge } from "./inference-providers-screen";

const SECTION_CLASS =
  "mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]";

function settingPlaceholder(key: string) {
  switch (key) {
    case "project":
      return "my-gcp-project";
    case "location":
      return "us-central1";
    case "resourceName":
      return "Paste the resource name or Azure Foundry project URL";
    default:
      return "";
  }
}

export function InferenceProviderEditorScreen({ inferenceProviderId }: { inferenceProviderId?: string }) {
  const router = useRouter();
  const { orgId, orgSlug, orgContext, runReauthableAction } = useOrgDashboard();
  const { provider, busy, error } = useInferenceProvider(orgId, inferenceProviderId ?? null);

  const [catalogProviders, setCatalogProviders] = useState<DenModelsDevProviderSummary[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [catalogDetail, setCatalogDetail] = useState<DenModelsDevProviderDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [credentialMode, setCredentialMode] = useState<"org" | "member">("org");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyValues, setApiKeyValues] = useState<Record<string, string>>({});
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  // Resolved in the browser: the Den API origin derives from window.location.
  const [oauthRedirectUri, setOauthRedirectUri] = useState(getOauthCallbackPath());
  const [access, setAccess] = useState<ProviderAccessValue>({ allMembers: false, memberIds: [], teamIds: [] });
  const [active, setActive] = useState(true);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    setOauthRedirectUri(denApiEndpoint(getOauthCallbackPath()));
  }, []);

  useEffect(() => {
    if (!orgId) return;
    let canceled = false;
    setCatalogError(null);
    void requestLlmProviderCatalog(orgId)
      .then((providers) => {
        if (!canceled) setCatalogProviders(providers);
      })
      .catch((loadError) => {
        if (!canceled) {
          setCatalogError(loadError instanceof Error ? loadError.message : "Failed to load the provider catalog.");
        }
      });
    return () => {
      canceled = true;
    };
  }, [orgId]);

  // Populate the form from the stored provider (edit) or defaults (create).
  useEffect(() => {
    if (provider) {
      setSelectedProviderId(provider.providerId);
      setName(provider.name);
      setNameTouched(true);
      setSelectedModelIds(provider.models.map((model) => model.id));
      setSettings(provider.settings);
      setCredentialMode(provider.credentialMode);
      setOauthClientId(provider.oauthClientId ?? "");
      setAccess(provider.access ?? { allMembers: false, memberIds: [], teamIds: [] });
      setActive(provider.status === "active");
    } else {
      setSelectedProviderId("");
      setName("");
      setNameTouched(false);
      setSelectedModelIds([]);
      setSettings({});
      setCredentialMode("org");
      setOauthClientId("");
      setAccess({
        allMembers: false,
        memberIds: orgContext?.currentMember.id ? [orgContext.currentMember.id] : [],
        teamIds: [],
      });
      setActive(true);
    }
    setApiKey("");
    setApiKeyValues({});
    setServiceAccountJson("");
    setOauthClientSecret("");
  }, [orgContext?.currentMember.id, provider]);

  // den-api only allows member mode for Google Vertex; fall back to org when the provider changes.
  const memberModeSupported = !selectedProviderId || supportsMemberCredentialMode(selectedProviderId);
  useEffect(() => {
    if (!memberModeSupported) setCredentialMode("org");
  }, [memberModeSupported]);

  useEffect(() => {
    if (!orgId || !selectedProviderId) {
      setCatalogDetail(null);
      setDetailError(null);
      return;
    }
    let canceled = false;
    setDetailBusy(true);
    setDetailError(null);
    void requestLlmProviderCatalogDetail(orgId, selectedProviderId)
      .then((detail) => {
        if (canceled) return;
        setCatalogDetail(detail);
        setSelectedModelIds((current) => current.filter((entry) => detail.models.some((model) => model.id === entry)));
      })
      .catch((loadError) => {
        if (canceled) return;
        setCatalogDetail(null);
        setDetailError(loadError instanceof Error ? loadError.message : "Failed to load provider details.");
      })
      .finally(() => {
        if (!canceled) setDetailBusy(false);
      });
    return () => {
      canceled = true;
    };
  }, [orgId, selectedProviderId]);

  const catalogProviderOptions = useMemo(
    () =>
      buildCatalogProviderOptions(catalogProviders, (entry) =>
        isSupportedGatewayNpm(entry.npm) ? entry.id : `${entry.id} · not available via gateway`,
      ),
    [catalogProviders],
  );

  const selectedCatalog = catalogProviders.find((entry) => entry.id === selectedProviderId) ?? null;
  const npm = catalogDetail
    ? getProviderNpmPackage(catalogDetail.config)
    : selectedCatalog?.npm ?? (provider ? getProviderNpmPackage(provider.providerConfig) : null);
  const supported = selectedProviderId ? isSupportedGatewayNpm(npm) : true;
  const envNames = catalogDetail
    ? getProviderEnvNames(catalogDetail.config)
    : provider
      ? getProviderEnvNames(provider.providerConfig)
      : [];
  const requiredSettingKeys = getRequiredSettingKeys(npm);
  const isVertex = isGoogleVertexNpm(npm);
  const autoName = selectedCatalog?.name ?? catalogDetail?.name ?? "";
  const effectiveName = nameTouched && name.trim() ? name.trim() : autoName;
  const lockedMemberId = orgContext?.currentMember.id ?? null;
  const orgCredentialSaved = provider?.credentials?.some((credential) => credential.subject === "org" && credential.status === "active") ?? false;
  const hasOauthClientSecret = provider?.hasOauthClientSecret ?? false;

  async function save() {
    const validationError = validateInferenceProviderForm({
      npm,
      name: effectiveName,
      providerId: selectedProviderId,
      modelIds: selectedModelIds,
      settings,
      serviceAccountJson,
      credentialMode,
      oauthClientId,
      oauthClientSecret,
      hasOauthClientSecret,
    });
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaveError(null);
    setSaveBusy(true);
    try {
      await runReauthableAction("save-inference-provider", async () => {
        const saved = await saveInferenceProvider({
          inferenceProviderId: provider?.id ?? null,
          body: buildInferenceProviderRequestBody({
            name: effectiveName,
            providerId: selectedProviderId,
            modelIds: selectedModelIds,
            credentialMode,
            status: active ? "active" : "disabled",
            settings,
            envNames,
            apiKey,
            apiKeyValues,
            serviceAccountJson,
            oauthClientId,
            oauthClientSecret,
            access,
          }),
        });
        router.push(getGatewayProviderRoute(orgSlug, saved.id));
        router.refresh();
      });
    } catch (nextError) {
      setSaveError(nextError instanceof Error ? nextError.message : "Could not save the gateway provider.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function remove(target: DenInferenceProvider) {
    setSaveError(null);
    setDeleteBusy(true);
    try {
      await runReauthableAction("delete-inference-provider", async () => {
        await deleteInferenceProvider(target.id);
        router.push(getGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (nextError) {
      setSaveError(nextError instanceof Error ? nextError.message : "Could not delete the gateway provider.");
      setConfirmingDelete(false);
    } finally {
      setDeleteBusy(false);
    }
  }

  if (inferenceProviderId && busy && !provider) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading provider details...
        </div>
      </div>
    );
  }

  if (inferenceProviderId && !provider) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <DenNotice message={error ?? "That gateway provider could not be found."} tone="error" />
      </div>
    );
  }

  const backHref = provider ? getGatewayProviderRoute(orgSlug, provider.id) : getGatewayProvidersRoute(orgSlug);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
      <div className="mb-8 flex flex-col gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">
          {provider ? "Edit gateway provider" : "Add gateway provider"}
        </p>
        <h1 className="text-[34px] font-semibold tracking-[-0.07em] text-gray-950">
          {provider ? effectiveName || provider.name : "Add a provider via OpenWork Gateway"}
        </h1>
        <p className="max-w-[720px] text-[16px] leading-8 text-gray-500">
          Pick a provider and models, store the credential once, and choose who can use it. Members call it through the
          OpenWork inference gateway with their own OpenWork key.
        </p>
      </div>

      <div className="mb-8 flex items-center justify-between gap-4">
        <Link href={backHref} className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900">
          <ArrowLeft className="h-5 w-5" />
          Back
        </Link>
        {provider ? (
          <DenButton variant="destructive" data-testid="gateway-provider-delete" onClick={() => setConfirmingDelete(true)}>
            <Trash2 className="h-4 w-4" />
            Delete
          </DenButton>
        ) : null}
      </div>

      {saveError ? <DenNotice message={saveError} tone="error" className="mb-6" /> : null}

      <section className={SECTION_CLASS}>
        <h2 className="mb-6 text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Provider</h2>
        <div className="grid gap-6">
          <div className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Provider</span>
            <DenCombobox
              value={selectedProviderId}
              options={catalogProviderOptions}
              onChange={setSelectedProviderId}
              ariaLabel="Provider"
              placeholder="Select a provider..."
              searchPlaceholder="Search providers..."
              emptyLabel="No providers match"
            />
            <p className="text-[13px] text-gray-500">
              Anthropic, OpenAI, Azure, OpenAI-compatible, OpenRouter, Google and Google Vertex providers can be routed
              via OpenWork Gateway. Amazon Bedrock and custom providers are not supported yet.
            </p>
          </div>
          {catalogError ? <p className="text-[14px] text-red-600">{catalogError}</p> : null}
          {detailBusy ? <p className="text-[14px] text-gray-500">Loading provider details...</p> : null}
          {detailError ? <p className="text-[14px] text-red-600">{detailError}</p> : null}
          {selectedProviderId && !supported ? (
            <DenNotice
              tone="warning"
              message={`${selectedCatalog?.name ?? selectedProviderId} cannot be routed through the OpenWork gateway yet. Add it under Bring your Own Keys instead.`}
            />
          ) : null}

          <label className="grid gap-3">
            <span className="text-[14px] font-medium text-gray-700">Name</span>
            <DenInput
              data-testid="gateway-provider-name"
              value={effectiveName}
              onChange={(event) => {
                setName(event.target.value);
                setNameTouched(true);
              }}
              placeholder="Pick a provider first"
            />
          </label>

          {requiredSettingKeys.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {requiredSettingKeys.map((key) => (
                <label key={key} className="grid gap-3">
                  <span className="text-[14px] font-medium text-gray-700">{getSettingLabel(key)}</span>
                  <DenInput
                    data-testid={`gateway-provider-setting-${key}`}
                    value={settings[key] ?? ""}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        [key]: key === "resourceName" ? normalizeAzureResourceNameInput(event.target.value) : event.target.value,
                      }))
                    }
                    placeholder={settingPlaceholder(key)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className={SECTION_CLASS}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Models</h2>
          {catalogDetail ? (
            <span className="rounded-full bg-gray-200 px-3 py-1 text-[12px] font-medium text-gray-700">
              {selectedModelIds.length} {selectedModelIds.length === 1 ? "model selected" : "models selected"}
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-[15px] text-gray-500">Pick the exact models members can use through this provider.</p>
        <ProviderModelPicker
          models={catalogDetail ? catalogDetail.models : null}
          selectedModelIds={selectedModelIds}
          onChange={setSelectedModelIds}
        />
      </section>

      <section className={SECTION_CLASS}>
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Credential</h2>
            <p className="mt-2 text-[15px] text-gray-500">
              Stored on the OpenWork server only. Members never see it and it is never sent to devices.
            </p>
          </div>
          {provider ? <InferenceCredentialStatusBadge provider={provider} /> : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <DenOptionCard
            type="radio"
            name="gateway-credential-mode"
            testId="gateway-credential-mode-org"
            title="Organization key"
            description="One credential for everyone with access. Recommended for API keys."
            checked={credentialMode === "org"}
            onChange={() => setCredentialMode("org")}
          />
          <DenOptionCard
            type="radio"
            name="gateway-credential-mode"
            testId="gateway-credential-mode-member"
            title="Each member signs in"
            description={
              memberModeSupported
                ? "Every member authorizes their own Google account before using the models."
                : "Only available for Google Vertex providers (google-vertex, google-vertex-anthropic)."
            }
            checked={credentialMode === "member"}
            onChange={() => setCredentialMode("member")}
            disabled={!memberModeSupported}
          />
        </div>

        {credentialMode === "member" ? (
          <div className="mt-6 grid gap-6">
            <p className="rounded-[20px] bg-gray-50 px-5 py-4 text-[14px] leading-6 text-gray-600">
              No organization credential is stored. Members will be asked to sign in with Google from their OpenWork app
              the first time they use these models.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-3">
                <span className="text-[14px] font-medium text-gray-700">Google OAuth client ID</span>
                <DenInput
                  data-testid="gateway-provider-oauth-client-id"
                  value={oauthClientId}
                  onChange={(event) => setOauthClientId(event.target.value)}
                  placeholder="1234567890-abc.apps.googleusercontent.com"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="grid gap-3">
                <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-gray-700">
                  Google OAuth client secret
                  {hasOauthClientSecret ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
                      Configured
                    </span>
                  ) : null}
                </span>
                <DenInput
                  type="password"
                  data-testid="gateway-provider-oauth-client-secret"
                  value={oauthClientSecret}
                  onChange={(event) => setOauthClientSecret(event.target.value)}
                  placeholder={hasOauthClientSecret ? "Leave blank to keep the current secret" : "Paste the client secret"}
                  autoComplete="off"
                />
              </label>
            </div>
            <p className="text-[13px] text-gray-500">
              Create an Internal OAuth client in your Google Cloud project and add this redirect URI:{" "}
              <code data-testid="gateway-provider-oauth-redirect-uri" className="rounded bg-gray-100 px-2 py-0.5 font-mono text-[12px]">
                {oauthRedirectUri}
              </code>
            </p>
          </div>
        ) : (
          <div className="mt-6 grid gap-6">
            {isVertex ? (
              <label className="grid gap-3">
                <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-gray-700">
                  Service account JSON
                  {orgCredentialSaved ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
                      Configured
                    </span>
                  ) : null}
                </span>
                <DenTextarea
                  data-testid="gateway-provider-service-account"
                  value={serviceAccountJson}
                  onChange={(event) => setServiceAccountJson(event.target.value)}
                  rows={8}
                  placeholder={
                    orgCredentialSaved
                      ? "Leave blank to keep the current service account"
                      : '{ "type": "service_account", "project_id": "...", ... }'
                  }
                  spellCheck={false}
                />
                <span className="text-[13px] text-gray-500">
                  Paste the key file downloaded from Google Cloud. It is stored on the server and never shown again.
                </span>
              </label>
            ) : envNames.length > 1 ? (
              <>
                <p className="text-[14px] text-gray-500">
                  This provider reads several environment variables. Values left blank keep what is already saved.
                </p>
                {envNames.map((envName) => (
                  <label key={envName} className="grid gap-3">
                    <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-gray-700">
                      <code className="rounded bg-gray-100 px-2 py-0.5 font-mono text-[12px]">{envName}</code>
                      {orgCredentialSaved ? (
                        <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
                          Configured
                        </span>
                      ) : null}
                    </span>
                    <DenInput
                      type="password"
                      value={apiKeyValues[envName] ?? ""}
                      onChange={(event) => setApiKeyValues((current) => ({ ...current, [envName]: event.target.value }))}
                      placeholder={orgCredentialSaved ? "Leave blank to keep current value" : `Paste the ${envName} value`}
                    />
                  </label>
                ))}
              </>
            ) : (
              <label className="grid gap-3">
                <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-gray-700">
                  API key
                  {orgCredentialSaved ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
                      Configured
                    </span>
                  ) : null}
                </span>
                <DenInput
                  type="password"
                  data-testid="gateway-provider-api-key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={orgCredentialSaved ? "Leave blank to keep current credential" : "Paste the provider API key"}
                />
              </label>
            )}
          </div>
        )}
      </section>

      <section className={SECTION_CLASS}>
        <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Who can use it</h2>
        <p className="mt-2 text-[15px] text-gray-500">Grant everyone access, or pick teams and people.</p>
        <ProviderAccessPicker
          orgContext={orgContext}
          value={access}
          onChange={setAccess}
          lockedMemberId={lockedMemberId}
          testIdPrefix="gateway-provider"
        />
      </section>

      <section className={SECTION_CLASS}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Status</h2>
            <p className="mt-2 text-[15px] text-gray-500">
              {active ? "Members with access can use these models." : "Hidden from members until you turn it back on."}
            </p>
          </div>
          <DenSwitch checked={active} onChange={setActive} aria-label="Provider active" testId="gateway-provider-active" />
        </div>
      </section>

      <DenStickyActionBar
        testId="gateway-provider-save-bar"
        summary={
          <>
            {selectedProviderId ? (
              <DenBrandMark
                name={effectiveName || "Provider"}
                simpleIconSlug={getProviderIconSlug(selectedProviderId)}
                serviceUrl={catalogDetail ? getProviderDocUrl(catalogDetail.config) : null}
                className="h-6 w-6 rounded-[8px]"
                imageClassName="h-3.5 w-3.5"
              />
            ) : null}
            <span className="truncate font-medium text-gray-950">{effectiveName || "New gateway provider"}</span>
            <span className="text-gray-300">·</span>
            <span className="whitespace-nowrap">
              {selectedModelIds.length} {selectedModelIds.length === 1 ? "model" : "models"}
            </span>
            <span className="text-gray-300">·</span>
            <span className="truncate">
              {access.allMembers
                ? `Everyone in ${orgContext?.organization.name ?? "the organization"}`
                : `${access.teamIds.length} ${access.teamIds.length === 1 ? "team" : "teams"} · ${access.memberIds.length} ${access.memberIds.length === 1 ? "person" : "people"}`}
            </span>
          </>
        }
      >
        <Link href={backHref} className="px-2 text-[13px] font-medium text-gray-500 transition hover:text-gray-900">
          Cancel
        </Link>
        <DenButton data-testid="gateway-provider-save" loading={saveBusy} onClick={() => void save()}>
          {provider ? "Save provider" : "Create provider"}
        </DenButton>
      </DenStickyActionBar>

      {confirmingDelete && provider ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/30 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-gateway-provider-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <h2 id="delete-gateway-provider-title" className="text-[18px] font-semibold text-gray-950">
              Delete “{provider.name}”?
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-gray-500">
              This removes the provider, its stored credential, model list and access rules. Members lose these models
              on their next sync.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <DenButton variant="secondary" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </DenButton>
              <DenButton
                variant="destructive"
                data-testid="gateway-provider-delete-confirm"
                loading={deleteBusy}
                onClick={() => void remove(provider)}
              >
                Delete
              </DenButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
