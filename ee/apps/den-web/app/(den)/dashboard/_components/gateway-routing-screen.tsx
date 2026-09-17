"use client";

import { useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ChevronRight, LockKeyhole } from "lucide-react";
import type { GatewayRouterDefinition, GatewayRouterSummary } from "@openwork/types/den/gateway-router";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { newRouter, newRouterCategory, readRouter, routerRequest, RouterRequestError, saveRouter, targetAvailable, useGatewayRouters, validateRouter, type RouterTarget } from "./gateway-router-data";

function RoutingSkeleton() {
  return <div role="status" aria-label="Loading model routing" className="flex flex-col gap-3">
    {[0, 1, 2].map(row => <div key={row} aria-hidden="true" className="h-12 rounded-md bg-muted motion-safe:animate-pulse" />)}
  </div>;
}

function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  return <details className="group border-t border-border py-3">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium"><ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />{title}</summary>
    <div className="flex flex-col gap-3 pt-4">{children}</div>
  </details>;
}

export function GatewayRoutingScreen() {
  const { orgId, orgContext, orgBusy, orgError, mutationBusy } = useOrgDashboard();
  return <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 text-sm text-foreground" aria-labelledby="routing-heading">
    <h1 id="routing-heading" className="text-xl font-semibold tracking-tight">Model routing</h1>
    {orgError ? <DenNotice tone="error" message="Could not load this workspace. Retry using the workspace selector." />
      : orgBusy || mutationBusy === "switch-organization" || !orgId || orgContext?.organization.id !== orgId ? <RoutingSkeleton />
      : orgContext.deploymentCapabilities.aiGateway !== true ? <p className="flex items-center gap-2"><LockKeyhole aria-hidden="true" className="size-4" />AI Gateway is disabled. Ask your workspace administrator to enable it.</p>
      : <RoutingWorkspace key={orgId} orgId={orgId} />}
  </section>;
}

export function RoutingWorkspace({ orgId }: { orgId: string }) {
  const query = useGatewayRouters(orgId);
  const [editor, setEditor] = useState<{ key: number; router: GatewayRouterSummary | null } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  async function edit(id: string) {
    const request = ++generation.current;
    setOpening(id); setError(null);
    try {
      const router = await readRouter(orgId, id);
      if (request === generation.current) setEditor({ key: request, router });
    } catch { if (request === generation.current) setError("Could not open this router. Choose Edit to try again."); }
    finally { if (request === generation.current) setOpening(null); }
  }
  if (query.isPending) return <RoutingSkeleton />;
  if (!query.data) {
    const blocked = query.error instanceof RouterRequestError && (query.error.status === 403 || query.error.status === 503);
    const message = query.error instanceof RouterRequestError ? query.error.message : "Could not load model routing. Try again.";
    return <div className="flex flex-col gap-3">{blocked
      ? <p className="flex items-center gap-2"><LockKeyhole aria-hidden="true" className="size-4" />{message}</p>
      : <DenNotice tone="error" message={message} />}<DenButton variant="secondary" onClick={() => void query.refetch()}>Retry</DenButton></div>;
  }
  const { routers, targets } = query.data;
  return <>
    {query.error ? <div role="alert" className="flex flex-col items-start gap-2"><DenNotice tone="error" message="Could not refresh model routing. Showing the last loaded settings." /><p className="text-muted-foreground">Last loaded <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>{new Date(query.dataUpdatedAt).toLocaleString()}</time></p><DenButton variant="secondary" onClick={() => void query.refetch()}>Retry</DenButton></div> : null}
    {error ? <DenNotice tone="error" message={error} /> : null}
    {!targets.length ? <p className="flex items-center gap-2"><LockKeyhole aria-hidden="true" className="size-4" />No accessible OpenAI-compatible models. Ask your workspace administrator to grant model access.</p> : null}
    {editor ? <RouterEditor key={editor.key} orgId={orgId} initial={editor.router} targets={targets}
      onSaved={() => void query.refetch()} onClose={() => { generation.current++; setEditor(null); }} /> : <>
      <div className="flex flex-col gap-3 border-b border-border py-3 sm:flex-row sm:items-center sm:justify-between"><span className="text-muted-foreground">{routers.length ? `${routers.length} saved routers` : "No routers yet. Create a router to match prompt categories to models."}</span>
        <DenButton disabled={!targets.length} onClick={() => { const key = ++generation.current; setOpening(null); setEditor({ key, router: null }); }}>Create router</DenButton></div>
      <div className="divide-y divide-border" aria-label="Saved routers">{routers.map(router => <div key={router.id} className="flex min-h-12 items-center gap-4 py-3">
        <span className="min-w-0 flex-1 truncate font-medium">{router.name}</span><span className="text-muted-foreground">{router.status === "active" ? "Active" : "Disabled"}</span>
        {router.routes.some(route => !targetAvailable(route, targets)) ? <span className="text-muted-foreground">Model unavailable</span> : null}
        <DenButton variant="secondary" size="sm" aria-label={`Edit ${router.name}`} disabled={opening === router.id} onClick={() => void edit(router.id)}>Edit</DenButton>
      </div>)}</div>
      {opening ? <RoutingSkeleton /> : null}
    </>}
  </>;
}

export function RouterEditor({ orgId, initial, targets, onSaved, onClose }: {
  orgId: string; initial: GatewayRouterSummary | null; targets: RouterTarget[]; onSaved: () => void; onClose: () => void;
}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<GatewayRouterDefinition>(() => initial ?? newRouter());
  const [confidence, setConfidence] = useState(String(initial?.minConfidence ?? 0.6));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const edits = useRef(0);
  function change(next: GatewayRouterDefinition) { edits.current++; setDraft(next); setNotice(""); }
  function updateRoute(id: string, patch: Partial<GatewayRouterDefinition["routes"][number]>) {
    change({ ...draft, routes: draft.routes.map(route => route.id === id ? { ...route, ...patch } : route) });
  }
  async function save() {
    const definition: GatewayRouterDefinition = { name: draft.name.trim(), status: draft.status, routes: draft.routes.map(route => ({ ...route, description: route.description.trim() })), fallbackRouteId: draft.fallbackRouteId, minConfidence: confidence.trim() ? Number(confidence) : NaN };
    const problem = validateRouter(definition, targets);
    if (problem) { setError(problem); return; }
    if (definition.status === "active" && !consent) { setError("Acknowledge prompt sharing with Jev before saving an active router."); return; }
    const version = edits.current;
    setBusy(true); setError(null);
    try {
      const result = await saveRouter(orgId, definition, saved);
      setSaved(result);
      // Only advance server metadata: a response must never overwrite newer typing.
      setNotice(version === edits.current ? "Saved" : "Saved with newer unsaved changes");
      onSaved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save this router. Try again."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!saved) return;
    setBusy(true); setError(null);
    try { await routerRequest(orgId, `/${encodeURIComponent(saved.id)}`, "DELETE"); onSaved(); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not delete this router. Try again."); setDeleting(false); }
    finally { setBusy(false); }
  }
  return <form className="flex flex-col gap-4" aria-label="Router editor" onSubmit={event => { event.preventDefault(); if (!busy) void save(); }}>
    <div className="flex items-center justify-between gap-3"><h2 className="sr-only">{saved ? "Edit router" : "Create router"}</h2><span className="text-muted-foreground">{saved ? <>Last saved <time dateTime={saved.updatedAt}>{new Date(saved.updatedAt).toLocaleString()}</time></> : "Unsaved router"}</span><DenButton type="button" variant="ghost" disabled={busy} onClick={onClose}>Close editor</DenButton></div>
    <label className="grid min-h-12 items-center gap-2 border-b border-border py-0.5 sm:grid-cols-[1fr_2fr]">Name<DenInput value={draft.name} onChange={event => change({ ...draft, name: event.target.value })} required maxLength={100} /></label>
    <fieldset className="flex min-w-0 flex-col gap-3"><legend className="mb-3 font-medium">Prompt categories</legend>
      {draft.routes.map((route, index) => {
        const selected = targets.findIndex(target => target.inferenceProviderId === route.inferenceProviderId && target.model === route.model);
        return <div key={route.id} className="grid items-end gap-3 border-b border-border py-3 md:grid-cols-[1fr_1fr_auto]" data-testid="router-category">
          <label className="flex min-w-0 flex-col gap-2">Prompt category {index + 1}<DenInput value={route.description} placeholder="e.g. Code review and debugging" required maxLength={1000} onChange={event => updateRoute(route.id, { description: event.target.value })} /></label>
          <div className="flex min-w-0 flex-col gap-2"><label htmlFor={`model-${route.id}`}>Model {index + 1}</label><DenSelect id={`model-${route.id}`} aria-label={`Model ${index + 1}`} value={selected < 0 ? "" : String(selected)} onChange={event => {
            const target = targets[Number(event.target.value)];
            if (target) updateRoute(route.id, { inferenceProviderId: target.inferenceProviderId, model: target.model });
          }}><option value="" disabled>{route.model ? "Saved model unavailable — choose a model" : "Choose a model"}</option>{targets.map((target, i) => <option key={`${target.inferenceProviderId}:${target.model}`} value={String(i)}>{target.name} · {target.providerName}</option>)}</DenSelect></div>
          <DenButton type="button" variant="ghost" disabled={draft.routes.length <= 2} aria-label={`Remove category ${index + 1}`} onClick={() => change({ ...draft, routes: draft.routes.filter(item => item.id !== route.id), fallbackRouteId: draft.fallbackRouteId === route.id ? "" : draft.fallbackRouteId })}>Remove</DenButton>
        </div>;
      })}
      <div><DenButton type="button" variant="secondary" disabled={draft.routes.length >= 12} onClick={() => change({ ...draft, routes: [...draft.routes, newRouterCategory()] })}>Add category</DenButton></div>
    </fieldset>
    <div className="grid min-h-12 items-center gap-2 border-b border-border py-0.5 sm:grid-cols-[1fr_2fr]"><label htmlFor="router-fallback">Fallback category</label><DenSelect id="router-fallback" aria-label="Fallback category" value={draft.fallbackRouteId} onChange={event => change({ ...draft, fallbackRouteId: event.target.value })}><option value="" disabled>Choose a fallback</option>{draft.routes.map((route, index) => <option key={route.id} value={route.id}>{route.description || `Category ${index + 1}`}</option>)}</DenSelect></div>
    <Disclosure title="Advanced"><label className="flex flex-col gap-2">Minimum confidence<DenInput type="number" min="0" max="1" step="0.01" value={confidence} onChange={event => { edits.current++; setNotice(""); setConfidence(event.target.value); }} /></label><p className="text-muted-foreground">Below this confidence, requests use the fallback category.</p></Disclosure>
    <div className="flex flex-col divide-y divide-border">
      <div className="flex min-h-12 flex-col justify-center gap-2 py-2 sm:flex-row sm:items-center sm:justify-between"><p id="router-sharing">I agree to send the latest user text to Jev to choose a model.</p><DenSwitch aria-label="Acknowledge prompt sharing with Jev" checked={consent} onChange={setConsent} /></div>
      <div className="flex min-h-12 flex-col justify-center gap-2 py-2 sm:flex-row sm:items-center sm:justify-between"><span>Router active</span><DenSwitch aria-label="Router active" checked={draft.status === "active"} onChange={active => change({ ...draft, status: active ? "active" : "disabled" })} /></div>
    </div>
    {error ? <div role="alert"><DenNotice tone="error" message={error} /></div> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="flex items-center gap-3"><DenButton type="submit" disabled={busy || (draft.status === "active" && !consent)}>{busy ? "Saving…" : "Save router"}</DenButton>
      {saved ? <AlertDialog.Root open={deleting} onOpenChange={setDeleting}>
        <AlertDialog.Trigger render={<DenButton type="button" variant="destructive" disabled={busy} />}>Delete router</AlertDialog.Trigger>
        <AlertDialog.Portal><AlertDialog.Backdrop className="fixed inset-0 bg-foreground/20" /><AlertDialog.Popup className="fixed left-1/2 top-1/2 flex w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-border bg-background p-4 text-foreground">
          <AlertDialog.Title className="font-semibold">Delete {saved.name}?</AlertDialog.Title><AlertDialog.Description>Its endpoint will stop accepting requests. This cannot be undone.</AlertDialog.Description>
          <div className="flex justify-end gap-3"><AlertDialog.Close render={<DenButton type="button" variant="secondary" disabled={busy} />}>Keep router</AlertDialog.Close><DenButton type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>Confirm delete</DenButton></div>
        </AlertDialog.Popup></AlertDialog.Portal>
      </AlertDialog.Root> : null}
    </div>
    {saved ? <Disclosure title="Use this router"><code className="break-all text-xs">POST /api/v1/routers/{encodeURIComponent(saved.id)}/chat/completions</code><p className="text-muted-foreground">Use your existing Gateway key as the bearer token. Upstream provider secrets are not needed.</p><p className="text-muted-foreground">Saved configuration only. No live request has been tested here.</p></Disclosure> : null}
  </form>;
}
