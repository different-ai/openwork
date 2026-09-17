import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { suggestOpenworkReplacement, type OpenworkCatalogModel, type OpenworkSessionModel } from "@openwork/types/openwork-affordance";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { SessionModelTargetSetChangedError, type createSessionModelActions } from "../control/session-model-actions";

type ModelActions = ReturnType<typeof createSessionModelActions>;
type ConfirmError =
  | { type: "failed" }
  | { type: "target_set_refresh_failed" }
  | { type: "target_set_changed"; expectedCount: number; currentCount: number };

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
  const [error, setError] = useState<ConfirmError | null>(null);
  const catalog = useQuery({ queryKey: ["model-repick", props.workspaceId, props.sessionId], queryFn: props.loadModels, staleTime: 0 });
  const removed = useQuery({ queryKey: ["model-repick-removed", props.workspaceId, props.sessionId], queryFn: props.loadRemovedModels });
  const from = removed.data?.find((model) => model.providerId === props.from.providerId && model.modelId === props.from.modelId) ?? props.from;
  const suggestion = suggestOpenworkReplacement(from, catalog.data ?? [], props.workspaceDefault);
  const choice = selected ?? suggestion;
  const single = useQuery({
    queryKey: ["model-repick-single", props.workspaceId, props.sessionId, choice?.providerId, choice?.modelId],
    enabled: Boolean(choice) && !saved,
    queryFn: () => props.modelActions.setModel({ sessionId: props.sessionId, workspaceId: props.workspaceId, model: { ...choice, variant: null }, dryRun: true }),
    staleTime: 0,
    retry: false,
  });
  const preview = useQuery({
    queryKey: ["model-repick-preview", props.workspaceId, props.sessionId, props.from.providerId, props.from.modelId, choice?.providerId, choice?.modelId],
    enabled: Boolean(choice) && !saved,
    queryFn: () => props.modelActions.rebindModel({ workspaceId: props.workspaceId, from: props.from, to: { ...choice, variant: null }, dryRun: true }),
    staleTime: 0,
    retry: false,
  });
  const bulkReady = preview.isSuccess && !preview.isFetching && preview.data.count > 0;
  const canConfirm = !saving && Boolean(choice) && catalog.isSuccess && !catalog.isFetching
    && (all ? bulkReady : single.isSuccess && !single.isFetching);
  useEffect(() => { setAll(false); }, [props.sessionId, props.from.providerId, props.from.modelId]);
  const confirm = async () => {
    if (!canConfirm || !choice || (all && !preview.data)) return;
    setSaving(true);
    setError(null);
    try {
      if (all && preview.data) {
        await props.modelActions.rebindModel({ workspaceId: props.workspaceId, from: props.from, to: { ...choice, variant: null }, expectedSessionIds: preview.data.sessions.map((session) => session.sessionId) });
      } else {
        await props.modelActions.setModel({ sessionId: props.sessionId, workspaceId: props.workspaceId, model: { ...choice, variant: null } });
      }
      setSaved(true);
    } catch (cause) {
      if (cause instanceof SessionModelTargetSetChangedError) {
        const refreshed = await preview.refetch();
        setError(refreshed.isSuccess
          ? {
              type: "target_set_changed",
              expectedCount: cause.expectedSessionIds.length,
              currentCount: refreshed.data.count,
            }
          : { type: "target_set_refresh_failed" });
      } else {
        setError({ type: "failed" });
        void single.refetch();
        void preview.refetch();
        void catalog.refetch();
      }
    } finally {
      setSaving(false);
    }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) props.onClose(); }}>
    <DialogContent showCloseButton={!saving}>
      <DialogHeader>
        <DialogTitle className="pr-8 break-words">{t("models.repick_title", { model: from.displayName ?? from.modelId })}</DialogTitle>
      </DialogHeader>
      {saved ? <p role="status">{t("models.repick_saved")}</p> : <div className="flex flex-col gap-4">
        <Select disabled={saving} value={choice ? JSON.stringify([choice.providerId, choice.modelId]) : null} onValueChange={(value) => {
          setError(null);
          setSelected(catalog.data?.find((model) => JSON.stringify([model.providerId, model.modelId]) === value) ?? null);
        }}>
          <SelectTrigger className="w-full" aria-label={t("models.title")}><SelectValue>{choice?.displayName ?? t("models.repick_choose")}</SelectValue></SelectTrigger>
          <SelectContent>{(catalog.data ?? []).map((model) => <SelectItem key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])} aria-label={`${model.displayName} (${model.providerName})`}><span>{model.displayName}</span><span className="text-muted-foreground">{model.providerName}</span></SelectItem>)}</SelectContent>
        </Select>
        {!selected && suggestion && <p className="text-xs text-muted-foreground">{t("models.repick_suggested")}</p>}
        <RadioGroup disabled={saving} value={all ? "all" : "this"} onValueChange={(value) => { setError(null); setAll(value === "all"); }} aria-label={t("models.repick_scope")}>
          <label className="flex items-center gap-2"><RadioGroupItem value="this" />{t("models.repick_this")}</label>
          <label className="flex items-center gap-2"><RadioGroupItem value="all" disabled={!bulkReady} />{bulkReady ? t("models.repick_all", { count: preview.data.count }) : t("models.repick_all_unverified")}</label>
        </RadioGroup>
        {all && bulkReady && <ul className="max-h-36 overflow-auto text-xs text-muted-foreground">{preview.data?.sessions.map((session) => <li key={session.sessionId}>{session.title}</li>)}</ul>}
        <span className="text-xs text-muted-foreground">{t("models.repick_local")}</span>
        {preview.isError && <p role="alert" className="text-xs text-muted-foreground">{t("models.repick_bulk_failed")}</p>}
        {single.isError && !all && <p role="alert">{t("models.repick_single_failed")}</p>}
        {catalog.isError && <p role="alert">{t("models.repick_catalog_failed")}</p>}
        {error?.type === "target_set_changed" && <p role="alert">{t("models.repick_targets_changed", { before: error.expectedCount, after: error.currentCount })}</p>}
        {error?.type === "target_set_refresh_failed" && <p role="alert">{t("models.repick_targets_refresh_failed")}</p>}
        {error?.type === "failed" && <p role="alert">{t("models.repick_failed")}</p>}
        {catalog.data?.length === 0 && <p>{t("models.no_models_available")}</p>}
      </div>}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={props.onClose}>{t("common.close")}</Button>
        {!saved && <Button disabled={!canConfirm} onClick={() => void confirm()}>{t("models.repick_confirm", { count: all ? preview.data?.count ?? 0 : 1 })}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
