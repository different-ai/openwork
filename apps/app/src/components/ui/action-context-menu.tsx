/** @jsxImportSource react */
import { useLayoutEffect, useMemo, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { useRender } from "@base-ui/react/use-render";
import { usePlatform } from "@/react-app/kernel/platform";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./context-menu";
import { ActionMenuItems } from "./action-menu-items";
import { createNativeMenuController, type MenuAction } from "./action-menu-model";

export function useNativeContextMenu() {
  const { showContextMenu } = usePlatform();
  const controller = useMemo(() => showContextMenu ? createNativeMenuController(showContextMenu) : undefined, [showContextMenu]);
  useLayoutEffect(() => () => controller?.cancel(), [controller]);
  return controller?.show;
}

function hasNativeEditingPriority(event: Event) {
  const selection = window.getSelection();
  return Boolean(event.target instanceof Node && selection?.toString() && selection.containsNode(event.target, true)) || event.composedPath().some((node) =>
    node instanceof HTMLElement && (node.isContentEditable || node.matches("input, textarea, select, [role='textbox']")),
  );
}

type ActionContextMenuProps = {
  actions: readonly MenuAction[];
  children?: ReactNode;
  render?: ReactElement;
  className?: string;
  contentClassName?: string;
  includeEditing?: boolean;
  tabIndex?: number;
};

export function ActionContextMenu({ actions, children, render, className, contentClassName, includeEditing = false, tabIndex }: ActionContextMenuProps) {
  const showNative = useNativeContextMenu();

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!showNative || event.defaultPrevented || (!includeEditing && hasNativeEditingPriority(event.nativeEvent))) return;
    event.preventDefault();
    event.stopPropagation();
    void showNative(actions, { point: { x: event.clientX, y: event.clientY }, includeEditing });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
    if (showNative && !includeEditing && hasNativeEditingPriority(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : event.currentTarget;
    const rect = target.getBoundingClientRect();
    const point = { x: rect.left, y: rect.bottom };
    if (showNative) {
      void showNative(actions, { point, includeEditing });
    } else {
      // Base UI opens on contextmenu; supply the focused element's keyboard anchor.
      event.currentTarget.dispatchEvent(new window.MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: point.x, clientY: point.y,
      }));
    }
  };

  const editableMarker = includeEditing ? { "data-native-context-menu-editable": "" } : {};
  const nativeTrigger = useRender({
    enabled: Boolean(showNative),
    render,
    props: {
      ...editableMarker,
      "data-slot": "context-menu-trigger",
      className: cn("select-none", className),
      tabIndex,
      onContextMenu,
      onKeyDown,
      ...(children !== undefined ? { children } : {}),
    },
  });
  if (showNative) return nativeTrigger;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={render} className={className} tabIndex={tabIndex} onKeyDown={onKeyDown} {...editableMarker} {...(children !== undefined ? { children } : {})} />
      <ContextMenuContent className={contentClassName}>
        <ActionMenuItems actions={actions} variant="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
