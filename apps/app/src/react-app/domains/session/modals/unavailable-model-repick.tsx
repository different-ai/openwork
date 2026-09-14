import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { suggestOpenworkReplacement, type OpenworkCatalogModel, type OpenworkSessionModel } from "@openwork/types/openwork-affordance";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import type { createSessionModelActions } from "../control/session-model-actions";

type ModelActions = ReturnType<typeof createSessionModelActions>;

export function UnavailableModelRepick(props: {
  sessionId: string;
  workspaceId: string;
  from: OpenworkSessionModel;
  workspaceDefault: OpenworkSessionModel | null;
  loadModels: () => Promise<OpenworkCatalogModel[]>;
  loadRemovedModels: () => Promise<OpenworkSessionModel[]>;
  modelActions: ModelActions;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<OpenworkCatalogModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  const catalog = useQuery({ queryKey: ["model-repick", props.workspaceId, props.sessionId], queryFn: props.loadModels, staleTime: 0 });
  const removed = useQuery({ queryKey: ["model-repick-removed", props.workspaceId, props.sessionId], queryFn: props.loadRemovedModels });
  const from = removed.data?.find((model) => model.providerId === props.from.providerId && model.modelId === props.from.modelId) ?? props.from;
  const suggestion = suggestOpenworkReplacement(from, catalog.data ?? [], props.workspaceDefault);
  const choice = selected ?? suggestion;
  const preview = useQuery({
    queryKey: ["model-repick-preview", props.workspaceId, props.sessionId, props.from.providerId, props.from.modelId, choice?.providerId, choice?.modelId],
    enabled: Boolean(choice),
    queryFn: () => props.modelActions.rebindModel({ workspaceId: props.workspaceId, from: props.from, to: choice, dryRun: true }),
    staleTime: 0,
  });
  useEffect(() => { setAll(false); }, [props.sessionId, props.from.providerId, props.from.modelId]);
  const confirm = async () => {
    if (!choice || !preview.data) return;
    setSaving(true);
    setError(false);
    try {
      if (all) {
        await props.modelActions.rebindModel({ workspaceId: props.workspaceId, from: props.from, to: { ...choice, variant: null }, expectedSessionIds: preview.data.sessions.map((session) => session.sessionId) });
      } else {
        await props.modelActions.setModel({ sessionId: props.sessionId, model: { ...choice, variant: null } });
      }
      setSaved(true);
    } catch {
      setError(true);
      void preview.refetch();
      void catalog.refetch();
    } finally {
      setSaving(false);
    }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) props.onClose(); }}>
    <DialogContent showCloseButton={!saving}>
      <DialogHeader>
        <DialogTitle>{t("models.repick_title")}</DialogTitle>
        <DialogDescription>{t("models.repick_description", { model: from.displayName ?? from.modelId })}</DialogDescription>
      </DialogHeader>
      {saved ? <p role="status">{t("models.repick_saved")}</p> : <div className="flex flex-col gap-4">
        <Select value={choice ? JSON.stringify([choice.providerId, choice.modelId]) : null} onValueChange={(value) => {
          setSelected(catalog.data?.find((model) => JSON.stringify([model.providerId, model.modelId]) === value) ?? null);
        }}>
          <SelectTrigger className="w-full" aria-label={t("models.title")}><SelectValue>{choice?.displayName ?? t("models.repick_choose")}</SelectValue></SelectTrigger>
          <SelectContent>{(catalog.data ?? []).map((model) => <SelectItem key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])}>{model.displayName} · {model.providerName}</SelectItem>)}</SelectContent>
        </Select>
        {!selected && suggestion && <p className="text-xs text-muted-foreground">{t("models.repick_suggested")}</p>}
        <RadioGroup value={all ? "all" : "this"} onValueChange={(value) => setAll(value === "all")} aria-label={t("models.repick_scope")}>
          <label className="flex items-center gap-2"><RadioGroupItem value="this" />{t("models.repick_this")}</label>
          <label className="flex items-center gap-2"><RadioGroupItem value="all" disabled={!preview.data?.count} />{t("models.repick_all", { count: preview.data?.count ?? 0, model: from.displayName ?? from.modelId })}</label>
        </RadioGroup>
        {all && <ul className="max-h-36 overflow-auto text-xs text-muted-foreground">{preview.data?.sessions.map((session) => <li key={session.sessionId}>{session.title}</li>)}</ul>}
        <p className="text-xs text-muted-foreground">{t("models.repick_local")}</p>
        {(error || catalog.isError || preview.isError) && <p role="alert">{t("models.repick_failed")}</p>}
        {catalog.data?.length === 0 && <p>{t("models.no_models_available")}</p>}
      </div>}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={props.onClose}>{t("models.done")}</Button>
        {!saved && <Button disabled={saving || !choice || !preview.data || preview.isFetching || catalog.isFetching} onClick={() => void confirm()}>{t("models.repick_confirm", { count: all ? preview.data?.count ?? 0 : 1 })}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
