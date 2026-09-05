/** @jsxImportSource react */
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "../../../../i18n";
import type { LibraryAddKind } from "../library";
import type { LibraryConnectorCue } from "../library-connector-cues";
import { LibraryAddKindPicker } from "./library-add-kind-picker";

export function libraryAddKindLabel(kind: LibraryAddKind) {
  switch (kind) {
    case "skill":
      return t("extensions.add_skill");
    case "command":
      return t("extensions.add_command");
    case "agent":
      return t("extensions.add_agent");
    case "mcp":
      return t("extensions.add_mcp");
    case "workspace-mcp":
      return t("extensions.add_workspace_mcp");
    case "plugin":
      return t("extensions.add_plugin");
    case "connection":
      return t("extensions.add_connection");
  }
}

export function LibraryAddControl(props: {
  kinds: LibraryAddKind[];
  connectorCues?: LibraryConnectorCue[];
  onSelect: (kind: LibraryAddKind) => void;
  pending?: boolean;
  size?: "xs" | "sm" | "default";
  variant?: "default" | "outline";
}) {
  const kinds = props.kinds;
  const [pickerOpen, setPickerOpen] = useState(false);
  if (kinds.length === 0) return null;
  const size = props.size ?? "default";
  const variant = props.variant ?? "default";
  const pendingLabel = t("den.checking_session");

  const onlyKind = kinds[0];
  if (kinds.length === 1 && onlyKind) {
    return (
      <Button
        variant={variant}
        size={size}
        className="shrink-0 rounded-lg"
        disabled={props.pending}
        aria-busy={props.pending}
        aria-label={props.pending ? `${libraryAddKindLabel(onlyKind)} — ${pendingLabel}` : undefined}
        title={props.pending ? pendingLabel : undefined}
        onClick={() => props.onSelect(onlyKind)}
      >
        {props.pending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
        {libraryAddKindLabel(onlyKind)}
      </Button>
    );
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className="shrink-0 gap-1 rounded-lg"
        onClick={() => setPickerOpen(true)}
      >
        <Plus size={16} />
        {t("common.add")}
      </Button>
      <LibraryAddKindPicker
        open={pickerOpen}
        kinds={kinds}
        connectorCues={props.connectorCues}
        onClose={() => setPickerOpen(false)}
        onSelect={props.onSelect}
      />
    </>
  );
}
