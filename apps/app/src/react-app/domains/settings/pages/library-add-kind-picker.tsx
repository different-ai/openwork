/** @jsxImportSource react */
import { ChevronRight, FileText, LayoutGrid, Plug, Server, SquareTerminal, UserRound } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "../../../../i18n";
import type { LibraryAddKind } from "../library";

const PICKER_KIND_ORDER: LibraryAddKind[] = [
  "skill",
  "connection",
  "mcp",
  "plugin",
];

type KindMeta = {
  title: string;
  description: string;
  icon: typeof FileText;
};

function kindMeta(kind: LibraryAddKind): KindMeta {
  switch (kind) {
    case "skill":
      return { title: t("extensions.kind_skill"), description: t("extensions.kind_skill_hint"), icon: FileText };
    case "command":
      return { title: t("extensions.kind_command"), description: t("extensions.kind_command_hint"), icon: SquareTerminal };
    case "agent":
      return { title: t("extensions.kind_agent"), description: t("extensions.kind_agent_hint"), icon: UserRound };
    case "plugin":
      return { title: t("extensions.kind_plugin"), description: t("extensions.kind_plugin_hint"), icon: LayoutGrid };
    case "mcp":
      return { title: t("extensions.kind_mcp"), description: t("extensions.empty_mcp_hint"), icon: Server };
    case "workspace-mcp":
      return { title: t("extensions.kind_workspace_mcp"), description: t("extensions.kind_workspace_mcp_hint"), icon: Server };
    case "connection":
      return { title: t("extensions.kind_connector"), description: t("extensions.kind_connector_hint"), icon: Plug };
  }
}

function KindRow(props: {
  kind: LibraryAddKind;
  onSelect: () => void;
}) {
  const meta = kindMeta(props.kind);
  const Icon = meta.icon;
  return (
    <button
      type="button"
      data-kind={props.kind}
      className="flex w-full items-center gap-3.5 border-t border-dls-border px-1 py-4 text-left transition-colors first:border-t-0 hover:bg-dls-hover/60"
      onClick={props.onSelect}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-dls-border bg-dls-surface text-dls-secondary">
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span data-kind-title={props.kind} className="block text-sm font-semibold text-dls-text">
          {meta.title}
        </span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-dls-secondary">
          {meta.description}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-dls-secondary" />
    </button>
  );
}

/** Add to your Library: one row per kind; a click goes straight to that kind's next step. */
export function LibraryAddKindPicker(props: {
  open: boolean;
  kinds: LibraryAddKind[];
  onClose: () => void;
  onSelect: (kind: LibraryAddKind) => void;
}) {
  const orderedKinds = PICKER_KIND_ORDER.filter((kind) => props.kinds.includes(kind));
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[min(92dvh,880px)] gap-4 overflow-y-auto lg:max-w-xl lg:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold tracking-[-0.01em]">
            {t("extensions.add_picker_title")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col" data-testid="library-add-choices">
          {orderedKinds.map((kind) => (
            <KindRow
              key={kind}
              kind={kind}
              onSelect={() => {
                props.onClose();
                props.onSelect(kind);
              }}
            />
          ))}
        </div>
        <p className="border-t border-dls-border pt-3.5 text-xs text-dls-secondary">{t("extensions.add_picker_footer")}</p>
      </DialogContent>
    </Dialog>
  );
}
