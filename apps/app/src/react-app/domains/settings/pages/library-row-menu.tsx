/** @jsxImportSource react */
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "../../../../i18n";

export type LibraryRowMenuAction = "open" | "edit" | "share" | "duplicate" | "stop_sharing" | "delete";

/**
 * The ⋯ menu on something the member made. Edit only appears for kinds with
 * something to write; Stop sharing only once it is shared.
 */
export function LibraryRowMenu(props: {
  name: string;
  canEdit: boolean;
  canDuplicate: boolean;
  shared: boolean;
  onAction: (action: LibraryRowMenuAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 text-dls-secondary"
            aria-label={t("extensions.row_menu_label", { name: props.name })}
          />
        )}
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => props.onAction("open")}>{t("extensions.row_menu_open")}</DropdownMenuItem>
          {props.canEdit ? (
            <DropdownMenuItem onClick={() => props.onAction("edit")}>{t("extensions.row_menu_edit")}</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => props.onAction("share")}>{t("extensions.row_menu_share")}</DropdownMenuItem>
          {props.canDuplicate ? (
            <DropdownMenuItem onClick={() => props.onAction("duplicate")}>{t("extensions.row_menu_duplicate")}</DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {props.shared ? (
            <DropdownMenuItem onClick={() => props.onAction("stop_sharing")}>{t("extensions.row_menu_stop_sharing")}</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={() => props.onAction("delete")}>
            {t("extensions.row_menu_delete")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
