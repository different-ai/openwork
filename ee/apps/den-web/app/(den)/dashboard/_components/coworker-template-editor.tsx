"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { COWORKER_TEMPLATE_SCHEMA, coworkerTemplateSchema, type CoworkerTemplate } from "@openwork/types/coworker-template";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { pluginQueryKeys } from "./plugin-data";

const emptyTemplate: CoworkerTemplate = { kind: "coworker", schemaVersion: 1, name: "", description: "", role: "", mission: "", instructions: "", avatarColor: "blue", avatarGlasses: "round", provisioning: "automatic" };
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

export function CoworkerTemplateEditor(props: { pluginId: string; coworkerId?: string }) {
  const { orgContext, orgSlug } = useOrgDashboard();
  if (!orgContext) return <p className="p-8 text-sm text-gray-500">Loading organization…</p>;
  if (!orgContext.capabilities.coworkerTeams) return <div className="p-8 text-sm text-gray-500">
    <Link href={getPluginRoute(orgSlug, props.pluginId)}>← Back to plugin</Link>
    <p className="mt-4">Prepared coworker teams are not enabled for this organization.</p>
  </div>;
  return <EnabledCoworkerTemplateEditor {...props} />;
}

function EnabledCoworkerTemplateEditor({ pluginId, coworkerId }: { pluginId: string; coworkerId?: string }) {
  const { orgId, orgSlug, runReauthableAction } = useOrgDashboard();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CoworkerTemplate>(emptyTemplate);
  const [loaded, setLoaded] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const back = getPluginRoute(orgSlug, pluginId);
  const query = useQuery({
    queryKey: ["coworker-template", orgId, pluginId, coworkerId], enabled: Boolean(orgId && coworkerId),
    queryFn: async () => {
      const [detail, memberships] = await Promise.all([
        requestJson(`/v1/config-objects/${encodeURIComponent(coworkerId ?? "")}`, { method: "GET" }, 15000),
        requestJson(`/v1/config-objects/${encodeURIComponent(coworkerId ?? "")}/plugins`, { method: "GET" }, 15000),
      ]);
      if (!detail.response.ok) throw new Error(getErrorMessage(detail.payload, "Coworker template could not be loaded."));
      if (!memberships.response.ok || !isRecord(memberships.payload) || !Array.isArray(memberships.payload.items)
        || !memberships.payload.items.some((entry) => isRecord(entry) && entry.pluginId === pluginId && entry.removedAt === null)) throw new Error("This coworker is not part of the plugin.");
      const item = isRecord(detail.payload) && isRecord(detail.payload.item) ? detail.payload.item : null;
      if (item?.objectType !== "agent" || !isRecord(item.latestVersion)) throw new Error("This is not a coworker template.");
      return coworkerTemplateSchema.parse(item.latestVersion.normalizedPayloadJson);
    },
  });
  useEffect(() => { if (query.data && coworkerId && loaded !== coworkerId) { setDraft(query.data); setLoaded(coworkerId); } }, [coworkerId, loaded, query.data]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    const parsed = coworkerTemplateSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Complete the coworker profile."); return; }
    setBusy(true);
    try {
      await runReauthableAction("save-coworker-template", async () => {
        const input = { normalizedPayloadJson: parsed.data, schemaVersion: COWORKER_TEMPLATE_SCHEMA };
        const { response, payload } = await requestJson(coworkerId ? `/v1/config-objects/${encodeURIComponent(coworkerId)}/versions` : "/v1/config-objects", {
          method: "POST",
          body: JSON.stringify(coworkerId ? { input, reason: "Updated coworker template" } : { type: "agent", sourceMode: "cloud", pluginIds: [pluginId], input }),
        }, 15000);
        if (!response.ok) throw getRequestError(payload, response, "The coworker template could not be saved.");
      });
      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.detail(pluginId) });
      await queryClient.invalidateQueries({ queryKey: ["coworker-template", orgId, pluginId] });
      router.push(back);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The coworker template could not be saved."); }
    finally { setBusy(false); }
  }
  function exportTemplate() {
    const parsed = coworkerTemplateSchema.safeParse(draft);
    if (!parsed.success) { setError("Complete the profile before exporting it."); return; }
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(parsed.data, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${draft.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}.coworker.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function archiveTemplate() {
    if (!coworkerId) return;
    setBusy(true); setError("");
    try {
      await runReauthableAction("archive-coworker-template", async () => {
        const { response, payload } = await requestJson(`/v1/config-objects/${encodeURIComponent(coworkerId)}/archive`, { method: "POST" }, 15000);
        if (!response.ok) throw getRequestError(payload, response, "The coworker template could not be archived.");
      });
      await queryClient.invalidateQueries({ queryKey: pluginQueryKeys.detail(pluginId) });
      router.push(back);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The coworker template could not be archived."); }
    finally { setBusy(false); }
  }
  if (query.error) return <p className="p-8 text-sm text-red-700" role="alert">{query.error.message}</p>;
  if (coworkerId && loaded !== coworkerId) return <p className="p-8 text-sm text-gray-500">Loading coworker…</p>;
  return <div className="mx-auto max-w-[820px] px-6 py-8 md:px-8" data-testid="coworker-template-editor">
    <Link href={back} className="text-sm text-gray-500 hover:text-gray-900">← Back to plugin</Link>
    <h1 className="mt-6 text-2xl font-semibold tracking-tight text-gray-950">{coworkerId ? "Edit coworker template" : "Add a coworker"}</h1>
    <p className="mt-2 text-sm leading-6 text-gray-500">Give new teammates a coworker who already understands its role. Assign this plugin to people, teams, or a marketplace using its existing access settings.</p>
    <form className="mt-6 space-y-5 rounded-2xl border border-gray-100 bg-white p-6" onSubmit={(event) => void submit(event)}>
      <label className="block text-sm font-medium">Import a coworker template
        <input type="file" accept=".json,application/json" className="mt-2 block text-sm" onChange={(event) => {
          const file = event.target.files?.[0]; if (!file) return;
          void (async () => {
            try {
              if (file.size > 131072) throw new Error("Templates must be 128 KB or smaller.");
              setDraft(coworkerTemplateSchema.parse(JSON.parse(await file.text()))); setError("");
            } catch { setError("Choose a valid coworker template. Memory, credentials, and working files are not accepted."); }
          })();
        }} />
      </label>
      <label className="block text-sm font-medium">Name<DenInput className="mt-2" required maxLength={80} value={draft.name} placeholder="Campaign partner" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="block text-sm font-medium">Role<DenInput className="mt-2" required maxLength={160} value={draft.role} placeholder="Marketing strategist" onChange={(e) => setDraft({ ...draft, role: e.target.value })} /></label>
      <label className="block text-sm font-medium">Description<DenInput className="mt-2" required maxLength={1024} value={draft.description} placeholder="Helps plan campaigns and turn a brief into next steps." onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
      <label className="block text-sm font-medium">Mission<DenTextarea className="mt-2" required maxLength={4000} rows={3} value={draft.mission} placeholder="What should this coworker help a new teammate accomplish?" onChange={(e) => setDraft({ ...draft, mission: e.target.value })} /></label>
      <label className="block text-sm font-medium">Reusable instructions<DenTextarea className="mt-2" maxLength={16000} rows={8} value={draft.instructions} placeholder="Ways of working, brand guidance, and questions to ask before starting. Include only information intended for everyone assigned this coworker." onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></label>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={draft.provisioning === "automatic"} onChange={(e) => setDraft({ ...draft, provisioning: e.target.checked ? "automatic" : "optional" })} /><span>Add automatically for assigned teammates<span className="mt-1 block text-xs leading-5 text-gray-500">Open Coworker adds a fresh copy when they sign in or refresh their team. Browsing as an administrator does not create coworkers. Existing working copies are never overwritten.</span></span></label>
      <p className="text-xs leading-5 text-gray-500">Apps and models remain governed by each member's access. Templates do not carry credentials, conversations, personal memories, or running responsibilities.</p>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <div className="flex flex-wrap gap-3">
        <DenButton type="submit" disabled={busy}>{busy ? "Saving…" : "Save coworker"}</DenButton>
        <DenButton type="button" disabled={busy} onClick={exportTemplate}>Export template</DenButton>
        {coworkerId ? <DenButton type="button" disabled={busy} onClick={() => setArchiveConfirm(true)}>Archive template</DenButton> : null}
      </div>
      {archiveConfirm ? <div className="space-y-3 rounded-xl border border-gray-200 p-4 text-sm" role="alert">
        <p>Stop delivering this template from every plugin that includes it? Existing personal copies and their work are kept.</p>
        <div className="flex gap-3"><DenButton type="button" disabled={busy} onClick={() => void archiveTemplate()}>Confirm archive</DenButton><DenButton type="button" disabled={busy} onClick={() => setArchiveConfirm(false)}>Cancel</DenButton></div>
      </div> : null}
    </form>
  </div>;
}
