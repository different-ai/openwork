/** @jsxImportSource react */
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader";
import { t } from "../../../../i18n";
import { isActiveWorkSessionStatus, isNeedsAttentionSessionStatus } from "../sidebar/utils";

/** The side pane keeps its own status visible even when its latest tool is offscreen. */
export function WorkbenchPaneStatus({ status, attentionLabel }: { status?: string; attentionLabel?: string }) {
  const waiting = isNeedsAttentionSessionStatus(status);
  const working = isActiveWorkSessionStatus(status);
  const label = waiting ? attentionLabel ?? t("workspace_list.session_needs_attention") : t("workspace_list.session_streaming");
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground" data-workbench-pane-status={waiting ? "waiting" : working ? "working" : "idle"}>
      {waiting ? (
        <span role="status" aria-label={label} title={label} className="size-2 rounded-full bg-warning" />
      ) : working ? (
        <DotMatrixLoader label={label} />
      ) : null}
    </span>
  );
}
