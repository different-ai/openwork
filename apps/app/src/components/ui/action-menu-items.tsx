/** @jsxImportSource react */
import { Fragment } from "react";
import {
  ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
} from "./context-menu";
import {
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from "./dropdown-menu";
import { dispatchMenuAction, type MenuAction } from "./action-menu-model";

/** Both web presenters consume the same action definitions as the native menu. */
export function ActionMenuItems({ actions, variant }: { actions: readonly MenuAction[]; variant: "context" | "dropdown" }) {
  const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const Separator = variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = variant === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = variant === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = variant === "context" ? ContextMenuSubContent : DropdownMenuSubContent;

  return actions.map((action, index) => {
    if (action.type === "separator") return <Separator key={`separator-${index}`} />;
    const content = action.webContent ?? <>{action.icon}{action.label}</>;
    return (
      <Fragment key={action.id}>
        {action.submenu ? (
          <Sub>
            <SubTrigger className="gap-2" disabled={action.disabled} {...action.dataAttributes}>{content}</SubTrigger>
            <SubContent className={action.submenuClassName?.[variant]}>
              <ActionMenuItems actions={action.submenu} variant={variant} />
            </SubContent>
          </Sub>
        ) : (
          <Item
            disabled={action.disabled}
            variant={action.variant}
            {...action.dataAttributes}
            onClick={() => void dispatchMenuAction(actions, action.id).catch((error: unknown) => console.error("Menu action failed", error))}
          >
            {content}
          </Item>
        )}
        {action.disabledReason ? <p className="px-2 py-1 text-xs text-muted-foreground">{action.disabledReason}</p> : null}
      </Fragment>
    );
  });
}
