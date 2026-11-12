import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { dispatchMenuAction } from "@/components/ui/action-menu-model";
import type { SessionAction, SessionActionItem } from "./session-action-catalog";

type Props = Omit<ComponentProps<typeof Button>, "onClick" | "children" | "disabled" | "aria-label" | "title"> & {
  action: SessionActionItem;
  actions: readonly SessionAction[];
  showTitle?: boolean;
};

/** Layout stays local; naming, state, icon and invocation come only from the resolved instance. */
export function SessionQuickActionButton({ action, actions, showTitle, ...props }: Props) {
  return <Button {...props} variant="ghost" size="icon" aria-label={action.label} disabled={action.disabled}
    title={showTitle ? action.label : undefined}
    onClick={(event) => {
      event.stopPropagation();
      void dispatchMenuAction(actions, action.id);
    }}>
    {action.icon}
  </Button>;
}
