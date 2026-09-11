"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { getGatewayProviderRoute, getGatewayProvidersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { deleteInferenceProvider, saveInferenceProvider, useInferenceProvider } from "./inference-provider-data";
import { getRequiredSettingKeys, getSettingLabel, isSupportedGatewayNpm } from "./inference-provider-request";
import { getProviderNpmPackage, requestLlmProviderCatalog, requestLlmProviderCatalogDetail, type DenModelsDevProviderDetail, type DenModelsDevProviderSummary } from "./llm-provider-data";
import { normalizeAzureResourceNameInput } from "./llm-provider-guided";
import { buildCatalogProviderOptions } from "./llm-provider-pickers";
import { GatewayAccessMatrix } from "./inference-provider-matrix";
import { GatewayModelUniverse } from "./inference-provider-model-universe";

const SECTION_CLASS = "mb-8 border-b border-gray-200 pb-8";

export function InferenceProviderEditorScreen({ inferenceProviderId }: { inferenceProviderId?: string }) {
  const router = useRouter();
  const { orgId, orgSlug, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const { provider, busy, error, reload } = useInferenceProvider(orgId, inferenceProviderId ?? null);
  const [catalog, setCatalog] = useState<DenModelsDevProviderSummary[]>([]);
  const [detail, setDetail] = useState<DenModelsDevProviderDetail | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState("");
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [allowAllModels, setAllowAllModels] = useState(true);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const initializedProviderId = useRef<string | null>(null);

  useEffect(() => {
    if (!provider || initializedProviderId.current === provider.id) return;
    initializedProviderId.current = provider.id;
    setProviderId(provider.providerId);
    setName(provider.name);
    setModelIds(provider.modelIds ?? provider.catalogModels.map((model) => model.id));
    setAllowAllModels(provider.modelIds !== null && provider.modelIds.length === 0);
    setSettings(provider.settings);
    setActive(provider.status === "active");
  }, [provider]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void requestLlmProviderCatalog(orgId).then((result) => {
      if (!cancelled) setCatalog(result);
    }).catch(() => {
      if (!cancelled) setCatalogError("Could not load the provider catalog.");
    });
    return () => { cancelled = true; };
  }, [orgId]);

  useEffect(() => {
    setDetail(null);
    if (!orgId || !providerId) return;
    let cancelled = false;
    setCatalogError(null);
    void requestLlmProviderCatalogDetail(orgId, providerId).then((result) => {
      if (!cancelled) setDetail(result);
    }).catch(() => {
      if (!cancelled) setCatalogError("Could not load this provider's models. Existing configuration has not changed.");
    });
    return () => { cancelled = true; };
  }, [orgId, providerId]);

  const npm = detail ? getProviderNpmPackage(detail.config) : null;
  async function save() {
    setSaveError(null);
    if (!detail || detail.id !== providerId) return setSaveError("Select a provider and wait for its catalog to load.");
    if (!isSupportedGatewayNpm(npm)) return setSaveError("This provider is not supported by AI Gateway.");
    if (!name.trim()) return setSaveError("Give the provider a name.");
    if (!allowAllModels && !modelIds.length) return setSaveError("Select at least one model, or turn on Allow all models.");
    for (const key of getRequiredSettingKeys(npm)) {
      if (!settings[key]?.trim()) return setSaveError(`${getSettingLabel(key)} is required.`);
    }
    setSaving(true);
    try {
      await runReauthableAction("save-inference-provider", async () => {
        const saved = await saveInferenceProvider({
          inferenceProviderId: provider?.id ?? null,
          body: {
            name: name.trim(), modelIds: allowAllModels ? [] : modelIds, status: active ? "active" : "disabled",
            // Editing the catalog never writes credentials or legacy flat access.
            ...(!provider ? { providerId, credentialMode: "org", allMembers: false, memberIds: [], teamIds: [] } : {}),
            ...(provider && JSON.stringify(settings) === JSON.stringify(provider.settings) ? {} : { settings }),
          },
        });
        router.push(getGatewayProviderRoute(orgSlug, saved.id));
        router.refresh();
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save the provider.");
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!provider || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await runReauthableAction("delete-inference-provider", async () => {
        await deleteInferenceProvider(provider.id);
        setConfirmDelete(false);
        router.push(getGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not delete the provider.");
    } finally { setSaving(false); }
  }

  if (inferenceProviderId && !provider) return <div className="p-8">{busy ? "Loading provider..." : <DenNotice tone="error" message={error ?? "Provider not found."} />}</div>;
  const backHref = provider ? getGatewayProviderRoute(orgSlug, provider.id) : getGatewayProvidersRoute(orgSlug);
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
      <Link href={backHref} className="text-sm text-gray-500">Back</Link>
      <h1 className="my-6 text-3xl font-semibold">{provider ? `Edit ${provider.name}` : "Add an AI Gateway provider"}</h1>
      <p className="mb-8 text-gray-500">Choose the model universe first, then create model groups, upstream keys and access groups. Administrators are not automatically granted model access.</p>
      {saveError ? <DenNotice tone="error" message={saveError} className="mb-6" /> : null}
      {catalogError ? <DenNotice tone="error" message={catalogError} className="mb-6" /> : null}
      <section className={SECTION_CLASS}>
        <h2 className="mb-5 text-xl font-semibold">Provider</h2>
        {provider ? <p className="mb-5 text-sm text-gray-500">The provider and its connection settings are fixed after creation. Create a new provider to use a different destination.</p> : null}
        <div className="grid gap-6">
          {provider ? <p>{provider.providerId}</p> : <DenCombobox
            ariaLabel="Provider" value={providerId} options={buildCatalogProviderOptions(catalog.filter((item) => isSupportedGatewayNpm(item.npm)))}
            onChange={(id) => { setProviderId(id); setName(catalog.find((item) => item.id === id)?.name ?? ""); setModelIds([]); setAllowAllModels(true); setSettings({}); }}
            placeholder="Select a provider..." searchPlaceholder="Search providers..." emptyLabel="No providers match"
          />}
          <div className="grid gap-2">
            <div className="grid gap-1">
              <label htmlFor="gateway-provider-name">Name</label>
              <p id="gateway-provider-name-description" className="text-sm text-gray-500">Give this provider a unique name to differentiate it in your org</p>
            </div>
            <DenInput id="gateway-provider-name" data-testid="gateway-provider-name" aria-describedby="gateway-provider-name-description" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          {getRequiredSettingKeys(npm).map((key) => <label key={key} className="grid gap-2">{getSettingLabel(key)}<DenInput
            readOnly={Boolean(provider)}
            value={settings[key] ?? ""} onChange={(event) => setSettings((current) => ({ ...current, [key]: key === "resourceName" ? normalizeAzureResourceNameInput(event.target.value) : event.target.value }))}
          /></label>)}
          <div className="flex items-center justify-between"><span>Provider active</span><DenSwitch checked={active} onChange={setActive} aria-label="Provider active" /></div>
        </div>
      </section>
      <section className={SECTION_CLASS}>
        <GatewayModelUniverse
          models={detail?.models ?? null}
          allowAllModels={allowAllModels}
          modelIds={modelIds}
          disabled={saving}
          warning={provider?.catalogWarning}
          onChange={(allowAll, selected) => { setAllowAllModels(allowAll); setModelIds(selected); }}
        />
      </section>
      {provider ? <GatewayAccessMatrix key={`${orgId}:${provider.id}`} provider={provider} reload={reload} /> : <DenNotice tone="info" message="Create the provider, then configure its model groups and credential sets. Access rules must be added explicitly; no one receives spend access by default." />}
      <DenStickyActionBar summary={allowAllModels ? "All models · follows catalog updates" : `${modelIds.length} selected models`}>
        <DenButton data-testid="gateway-provider-save" loading={saving} onClick={() => void save()}>{provider ? "Save provider and models" : "Create provider"}</DenButton>
      </DenStickyActionBar>
      {provider ? <div className="mt-8 grid gap-3">
        <AlertDialog.Root
          open={confirmDelete && !reauthDialogOpen}
          onOpenChange={(open) => {
            if (saving) return;
            setConfirmDelete(open);
            if (open) setSaveError(null);
          }}
        >
          <AlertDialog.Trigger disabled={saving} className={buttonVariants({ variant: "destructive", className: "w-fit" })}>
            Delete provider
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
            <AlertDialog.Popup
              initialFocus={cancelDeleteRef}
              aria-busy={saving}
              className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 outline-none"
            >
              <AlertDialog.Title className="text-xl font-semibold text-gray-950">Delete {provider.name}?</AlertDialog.Title>
              <AlertDialog.Description className="mt-3 text-sm leading-6 text-gray-600">
                This will delete the provider, its model groups, upstream keys and access rules. Members will lose access. This cannot be undone.
              </AlertDialog.Description>
              {saveError ? <DenNotice className="mt-4" tone="error" message={saveError} /> : null}
              <div className="mt-6 flex flex-wrap justify-end gap-3">
                <AlertDialog.Close ref={cancelDeleteRef} disabled={saving} className={buttonVariants({ variant: "secondary" })}>
                  Cancel
                </AlertDialog.Close>
                <DenButton variant="destructive" loading={saving} onClick={() => void remove()}>Delete provider</DenButton>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div> : null}
    </div>
  );
}
