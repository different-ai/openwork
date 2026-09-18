"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Dialog } from "@base-ui/react/dialog";
import type { GatewayCredentialSet, GatewayCredentialSetWrite, GatewayModelGroup } from "@openwork/types/den/gateway";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { getAiGatewayRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { deleteGatewayResource, saveGatewayResource } from "./inference-provider-data";
import { isGoogleVertexNpm, supportsMemberCredentialMode, type DenInferenceProviderDetails } from "./inference-provider-request";
import { formatProviderTimestamp, getProviderEnvNames, getProviderNpmPackage, requestLlmProviderCatalogDetail, type DenModelsDevProviderDetail } from "./llm-provider-data";
import { ProviderModelPicker } from "./llm-provider-pickers";

type Editor =
  | { resource: "model-groups"; id: string | null; name: string; description: string; modelIds: string[]; active: boolean }
  | { resource: "credential-sets"; id: string | null; name: string; credentialMode: "org" | "member"; active: boolean; oauthClientId: string; oauthClientSecret: string; hasOauthClientSecret: boolean; configured: boolean; secret: string; apiKeys: Record<string, string> };

const SECTION_CLASS = "mb-8 border-b border-gray-200 pb-8";

function modelGroupName(name: string) {
  // Display-only alias; the editor retains the stored name until it is changed.
  return name === "All configured models" || name === "all allowed models" ? "All Allowed Models" : name;
}

export function GatewayAccessMatrix({ provider, reload }: { provider: DenInferenceProviderDetails; reload: () => Promise<void> }) {
  const { orgId, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ resource: Editor["resource"]; id: string; name: string } | null>(null);
  const [catalog, setCatalog] = useState<DenModelsDevProviderDetail | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);
  const editorKey = editor ? `${editor.resource}:${editor.id ?? "new"}` : null;
  useEffect(() => {
    if (editorKey && !editorKey.startsWith("credential-sets:")) editorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [editorKey]);
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setCatalog(null);
    void requestLlmProviderCatalogDetail(orgId, provider.providerId).then((detail) => {
      if (!cancelled) setCatalog(detail);
    }).catch(() => {
      if (!cancelled) setError("Could not load the credential field definitions. Reload this page before editing credentials.");
    });
    return () => { cancelled = true; };
  }, [orgId, provider.providerId]);
  // Runtime config contains only Gateway-scoped env slots, not upstream key fields.
  const vertex = catalog ? isGoogleVertexNpm(getProviderNpmPackage(catalog.config)) : false;
  const envNames = catalog ? getProviderEnvNames(catalog.config) : [];

  function editGroup(group?: GatewayModelGroup) {
    setError(null);
    setEditor({ resource: "model-groups", id: group?.id ?? null, name: group?.name ?? "", description: group?.description ?? "", modelIds: group?.modelIds ?? [], active: !group || group.status === "active" });
  }
  function editSet(set?: GatewayCredentialSet) {
    setError(null);
    // Secret fields are write-only, always blank when opening an existing set.
    setEditor({ resource: "credential-sets", id: set?.id ?? null, name: set?.name ?? "", credentialMode: set?.credentialMode ?? "org", active: !set || set.status === "active", oauthClientId: set?.oauthClientId ?? "", oauthClientSecret: "", hasOauthClientSecret: set?.hasOauthClientSecret ?? false, configured: set?.configured ?? false, secret: "", apiKeys: {} });
  }
  async function save() {
    if (!editor) return;
    setError(null);
    if (!editor.name.trim()) return setError("Name is required.");
    if (editor.resource === "model-groups" && (!editor.modelIds.length || editor.modelIds.some((id) => !provider.catalogModels.some((model) => model.id === id)))) return setError("Select at least one model from the saved model universe.");
    if (editor.resource === "credential-sets") {
      if (!catalog) return setError("Wait for the provider's credential field definitions to load before saving.");
      if (editor.credentialMode === "member" && (!supportsMemberCredentialMode(provider.providerId) || !editor.oauthClientId.trim() || (!editor.oauthClientSecret.trim() && !editor.hasOauthClientSecret))) return setError("Member sign-in requires a supported provider and an OAuth client ID and secret.");
      if (editor.credentialMode === "org") {
        const existing = provider.credentialSets.find((set) => set.id === editor.id);
        const needsCredential = !existing || existing.credentialMode !== "org" || (editor.active && !editor.configured);
        const hasCredential = vertex || envNames.length <= 1
          ? Boolean(editor.secret.trim())
          : Object.values(editor.apiKeys).some((value) => value.trim());
        if (needsCredential && !hasCredential) return setError(vertex ? "Add service account credentials before saving this credential set." : "Enter an API key before saving this credential set.");
      }
      if (editor.credentialMode === "org" && vertex && editor.secret.trim()) {
        try {
          const value: unknown = JSON.parse(editor.secret);
          if (!value || typeof value !== "object" || !("type" in value) || value.type !== "service_account") return setError("Paste a Google service account key file (type: service_account).");
        } catch { return setError("The service account JSON could not be parsed."); }
      }
    }
    setBusy(true);
    try {
      await runReauthableAction("save-gateway-matrix", async () => {
        if (editor.resource === "model-groups") await saveGatewayResource(provider.id, editor.id, { resource: editor.resource, body: { name: editor.name.trim(), description: editor.description.trim() || null, modelIds: editor.modelIds, status: editor.active ? "active" : "disabled" } });
        if (editor.resource === "credential-sets") {
          const body: GatewayCredentialSetWrite = { name: editor.name.trim(), credentialMode: editor.credentialMode, status: editor.active ? "active" : "disabled" };
          if (editor.credentialMode === "member") {
            body.oauthClientId = editor.oauthClientId.trim();
            if (editor.oauthClientSecret.trim()) body.oauthClientSecret = editor.oauthClientSecret.trim();
          } else if (vertex || envNames.length <= 1) {
            if (editor.secret.trim()) body.credential = { kind: vertex ? "gcp_service_account" : "api_key", secret: editor.secret.trim() };
          } else {
            const entries = Object.entries(editor.apiKeys).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]);
            if (entries.length) body.apiKeys = Object.fromEntries(entries);
          }
          await saveGatewayResource(provider.id, editor.id, { resource: editor.resource, body });
        }
      });
      setEditor(null);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the matrix entry."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await runReauthableAction("delete-gateway-matrix", () => deleteGatewayResource(provider.id, deleting.resource, deleting.id));
      setDeleting(null);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete the matrix entry."); }
    finally { setBusy(false); }
  }

  const credentialColumns: readonly DenTableColumn<GatewayCredentialSet>[] = [
    { key: "name", header: "Name", render: (set) => <div className="min-w-40 break-words"><p className="font-medium">{set.name}</p><p className="text-sm text-gray-500">{set.credentialMode === "org" ? "Shared/Private API Key" : "Each Member Signs In"}</p></div> },
    { key: "creator", header: "Created by", render: (set) => <div className="break-words"><p>{set.createdBy?.name || set.createdBy?.email || "Not recorded"}</p>{set.createdBy?.name && set.createdBy.email ? <p className="text-sm text-gray-500">{set.createdBy.email}</p> : null}</div> },
    { key: "created", header: "Created date", render: (set) => set.createdAt && !Number.isNaN(Date.parse(set.createdAt)) ? formatProviderTimestamp(set.createdAt) : "Not recorded" },
    { key: "status", header: "Status", render: (set) => <div><DenBadge tone={set.status === "active" ? "success" : "neutral"}>{set.status}</DenBadge><p className="mt-1 text-sm text-gray-500">{set.configured ? "Configured" : "Not configured"}</p></div> },
    { key: "actions", header: "Actions", render: (set) => <div className="flex gap-2">
      <DenButton size="sm" disabled={busy} variant="secondary" aria-label={`Edit upstream key ${set.name}`} onClick={() => editSet(set)}>Edit</DenButton>
      <DenButton size="sm" disabled={busy} variant="destructive" aria-label={`Delete upstream key ${set.name}`} onClick={() => setDeleting({ resource: "credential-sets", id: set.id, name: set.name })}>Delete</DenButton>
    </div> },
  ];

  function renderEditor(resource: Editor["resource"]) {
    if (!editor || editor.resource !== resource) return null;
    const memberSignInSupported = supportsMemberCredentialMode(provider.providerId);
    const keyEditor = resource === "credential-sets";
    const title = `${editor.id ? "Edit" : "Add"} ${editor.resource === "model-groups" ? "model group" : "upstream key"}`;
    const panel = <section ref={keyEditor ? undefined : editorRef} className={keyEditor ? "min-w-0" : "mt-6 scroll-mt-6 border-t border-gray-200 pt-6"} aria-label="Matrix entry editor">
      {keyEditor ? <>
        <Dialog.Title className="mb-2 text-xl font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="mb-6 text-sm text-gray-500">Configure an upstream key or supported per-user sign-in connection for this provider.</Dialog.Description>
        {error ? <DenNotice className="mb-5" tone="error" message={error} /> : null}
      </> : <h3 className="mb-5 text-lg font-semibold">{title}</h3>}
      <fieldset disabled={busy} className="grid min-w-0 gap-5">
        <div className="grid gap-2">
          <div className="grid gap-1">
            <label htmlFor="gateway-matrix-entry-name">Name</label>
            {editor.resource === "credential-sets" ? <p id="gateway-credential-name-description" className="text-sm text-gray-500">Give this a friendly name to identify and manage easier</p> : null}
          </div>
          <DenInput id="gateway-matrix-entry-name" aria-describedby={editor.resource === "credential-sets" ? "gateway-credential-name-description" : undefined} value={editor.resource === "model-groups" ? modelGroupName(editor.name) : editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
        </div>
        <div className="flex items-center justify-between"><span>Active</span><DenSwitch checked={editor.active} onChange={(active) => setEditor({ ...editor, active })} aria-label="Entry active" /></div>
        {editor.resource === "model-groups" ? <>
          <label className="grid gap-2">Description<DenTextarea value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></label>
          <ProviderModelPicker models={provider.catalogModels} selectedModelIds={editor.modelIds} onChange={(modelIds) => setEditor({ ...editor, modelIds })} />
        </> : null}
        {editor.resource === "credential-sets" ? <>
          <div className="grid gap-3 md:grid-cols-2">
            <DenOptionCard type="radio" name="set-mode" title="Shared/Private API Key" description="Use an API key, then choose who can access it through your access rules." checked={editor.credentialMode === "org"} onChange={() => setEditor({ ...editor, credentialMode: "org", secret: "", apiKeys: {}, oauthClientSecret: "", configured: provider.credentialSets.some((set) => set.id === editor.id && set.credentialMode === "org" && set.configured) })} />
            <DenOptionCard type="radio" name="set-mode" title="Each Member Signs In" description={memberSignInSupported ? "Each member authorizes their own account for this set." : "This provider does not support per end user signin"} checked={editor.credentialMode === "member"} disabled={!memberSignInSupported} onChange={() => setEditor({ ...editor, credentialMode: "member", secret: "", apiKeys: {}, oauthClientSecret: "", configured: provider.credentialSets.some((set) => set.id === editor.id && set.credentialMode === "member" && set.configured) })} />
          </div>
          {editor.id ? <DenNotice tone="warning" message="Changing the credential mode or OAuth client, or disabling this set, revokes its current credentials. Members may need to sign in again; an API key may need to be supplied again." /> : null}
          {editor.credentialMode === "member" ? <>
            {memberSignInSupported && provider.oauthCallbackUrl ? <div className="grid gap-2">
              <p className="text-sm font-medium text-gray-700">OAuth callback URL</p>
              <code className="break-all rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">{provider.oauthCallbackUrl}</code>
              <p className="text-sm text-gray-500">Add this URL to the allowed redirect URIs in your OAuth client configuration.</p>
            </div> : null}
            <label className="grid gap-2">OAuth client ID<DenInput value={editor.oauthClientId} onChange={(event) => setEditor({ ...editor, oauthClientId: event.target.value })} autoComplete="off" /></label>
            <label className="grid gap-2">OAuth client secret {editor.hasOauthClientSecret ? "(configured)" : ""}<DenInput type="password" value={editor.oauthClientSecret} onChange={(event) => setEditor({ ...editor, oauthClientSecret: event.target.value })} autoComplete="new-password" placeholder={editor.hasOauthClientSecret ? "Saved secret — enter a replacement to change it" : "Enter OAuth client secret"} /></label>
          </> : vertex ? <label className="grid gap-2">Service account JSON<DenTextarea value={editor.secret} onChange={(event) => setEditor({ ...editor, secret: event.target.value })} rows={6} autoComplete="off" spellCheck={false} placeholder={editor.configured ? "Saved credentials — paste a replacement to change them" : "Paste service account JSON"} /></label> : envNames.length > 1 ? envNames.map((env) => <label key={env} className="grid gap-2">{env}<DenInput type="password" value={editor.apiKeys[env] ?? ""} onChange={(event) => setEditor({ ...editor, apiKeys: { ...editor.apiKeys, [env]: event.target.value } })} autoComplete="new-password" placeholder={editor.configured ? "Saved credentials — enter a replacement to change them" : "Enter API key"} /></label>) : <label className="grid gap-2">API key {editor.configured ? "(configured)" : ""}<DenInput type="password" value={editor.secret} onChange={(event) => setEditor({ ...editor, secret: event.target.value })} autoComplete="new-password" placeholder={editor.configured ? "Saved key — enter a replacement to change it" : "Enter API key"} /></label>}
        </> : null}
        <div className="flex gap-3"><DenButton loading={busy} onClick={() => void save()}>Save {editor.resource === "model-groups" ? "model group" : "upstream key"}</DenButton><DenButton variant="secondary" onClick={() => { setEditor(null); setError(null); }}>Cancel</DenButton></div>
      </fieldset>
    </section>;
    if (!keyEditor) return panel;
    // Release the modal focus trap while the workspace security prompt is open.
    // Keep editor state mounted so reauthentication can retry the same draft.
    return <Dialog.Root open={!reauthDialogOpen} onOpenChange={(open) => {
      if (!open && !busy) { setEditor(null); setError(null); }
    }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <Dialog.Popup aria-busy={busy} className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 outline-none md:p-8">
          {panel}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>;
  }

  function renderDeletion(resource: Editor["resource"]) {
    if (deleting?.resource !== resource) return null;
    return <section className="mt-6 border-t border-gray-200 pt-5" aria-label="Confirm matrix entry deletion">
      <p>Delete {deleting.name}? Referencing access rules may stop working. Server validation errors will be shown without silently changing other entries.</p>
      <div className="mt-4 flex flex-wrap gap-3"><DenButton variant="destructive" loading={busy} onClick={() => void remove()}>Confirm delete</DenButton><DenButton disabled={busy} variant="secondary" onClick={() => setDeleting(null)}>Cancel</DenButton></div>
    </section>;
  }

  return <div data-testid="gateway-access-matrix">
    {error && editor?.resource !== "credential-sets" ? <DenNotice className="mb-6" tone="error" message={error} /> : null}
    <section className={SECTION_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Model groups</h2><DenButton disabled={busy} onClick={() => editGroup()}>Add model group</DenButton></div>
      <p className="my-4 text-gray-500">Create reusable sets of models, then assign them to teams or people with an upstream key.</p>
      {!provider.modelGroups.length ? <p>No groups yet.</p> : <div className="grid gap-4 md:grid-cols-2">{provider.modelGroups.map((group) => <div key={group.id} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="min-w-0 break-words font-semibold">{modelGroupName(group.name)}</h3><DenBadge tone={group.status === "active" ? "success" : "neutral"}>{group.status}</DenBadge></div>
        {group.description ? <p className="break-words text-sm text-gray-500">{group.description}</p> : null}
        {group.modelIds.length ? <ul className="flex flex-wrap gap-2">
          {group.modelIds.slice(0, 7).map((id) => <li key={id} className="min-w-0 max-w-full"><DenBadge className="max-w-full whitespace-normal break-all">{provider.catalogModels.find((model) => model.id === id)?.name ?? id}</DenBadge></li>)}
          {group.modelIds.length > 7 ? <li><DenBadge>+{group.modelIds.length - 7} more</DenBadge></li> : null}
        </ul> : <p className="text-sm text-gray-500">No models in this group. It does not grant access to any models.</p>}
        <div className="mt-auto flex gap-2"><DenButton disabled={busy} variant="secondary" aria-label={`Edit model group ${modelGroupName(group.name)}`} onClick={() => editGroup(group)}>Edit</DenButton><DenButton disabled={busy} variant="destructive" aria-label={`Delete model group ${modelGroupName(group.name)}`} onClick={() => setDeleting({ resource: "model-groups", id: group.id, name: modelGroupName(group.name) })}>Delete</DenButton></div>
      </div>)}</div>}
      {renderEditor("model-groups")}
      {renderDeletion("model-groups")}
    </section>
    <section className={SECTION_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Ai Provider Upstream Keys</h2><DenButton disabled={busy} onClick={() => editSet()}>Add upstream key</DenButton></div>
      <p className="my-4 text-gray-500">Add named API keys or per-user sign-in connections, then choose them when assigning access.</p>
      <DenTable headerTone="plain" columns={credentialColumns} rows={provider.credentialSets} getRowKey={(set) => set.id} emptyLabel="No upstream keys yet." />
      {provider.credentialSets.some((set) => !set.createdBy || !set.createdAt) ? <p className="mt-3 text-sm text-gray-500">Creation metadata is not available for every key. Older records or servers awaiting migration may show Not recorded.</p> : null}
      {renderEditor("credential-sets")}
      {renderDeletion("credential-sets")}
    </section>
    <Link href={`${getAiGatewayRoute()}?tab=users-and-teams`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>Manage access in Users &amp; Teams</Link>
  </div>;
}
