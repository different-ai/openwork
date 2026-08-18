/** @jsxImportSource react */
import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "../../../../i18n";
import type { LibraryAddKind } from "../library";
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
    case "plugin":
      return t("extensions.add_plugin");
    case "connection":
      return t("extensions.add_connection");
  }
}

export function LibraryAddControl(props: {
  kinds: LibraryAddKind[];
  onSelect: (kind: LibraryAddKind) => void;
  size?: "xs" | "sm" | "default";
  variant?: "default" | "outline";
}) {
  const kinds = props.kinds;
  const [pickerOpen, setPickerOpen] = useState(false);
  if (kinds.length === 0) return null;
  const size = props.size ?? "default";
  const variant = props.variant ?? "default";

  const onlyKind = kinds[0];
  if (kinds.length === 1 && onlyKind) {
    return (
      <Button variant={variant} size={size} className="shrink-0 rounded-lg" onClick={() => props.onSelect(onlyKind)}>
        <Plus size={16} />
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
        onClose={() => setPickerOpen(false)}
        onSelect={props.onSelect}
      />
    </>
  );
}
