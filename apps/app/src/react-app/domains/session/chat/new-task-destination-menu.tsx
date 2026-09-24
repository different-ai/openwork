import { ChevronDown, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { NewSessionDestination } from "./new-session-destination";

type Props = {
  destination: NewSessionDestination;
  workspaces: { id: string; label: string }[];
  groups: { id: string; label: string }[];
  hasDraft: boolean;
  disabled: boolean;
  onChange: (destination: NewSessionDestination) => void;
  onDiscard: () => void;
};

/** Quiet context beside the model picker; no group UI until groups exist. */
export function NewTaskDestinationMenu(props: Props) {
  const workspaces = props.workspaces.filter((workspace) => !props.destination.parent || workspace.id === props.destination.parent.workspaceId);
  const hasGroups = props.groups.length > 0;
  const canChooseWorkspace = workspaces.length > 1;
  const hasDestinationChoices = hasGroups || canChooseWorkspace;
  if (!hasDestinationChoices && !props.hasDraft) return null;

  const workspaceLabel = workspaces.find((workspace) => workspace.id === props.destination.workspaceId)?.label ?? "Workspace";
  const groupLabel = props.destination.groupId
    ? props.groups.find((group) => group.id === props.destination.groupId)?.label ?? "Unavailable group"
    : "No group";

  return (
    <span className="min-w-0 max-w-full text-muted-foreground">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size={hasDestinationChoices ? "xs" : "icon-xs"} />}
          disabled={props.disabled}
          aria-label={hasGroups ? "Session destination" : canChooseWorkspace ? "Workspace destination" : "Draft actions"}
          title={hasGroups ? `${workspaceLabel} / ${groupLabel}` : canChooseWorkspace ? workspaceLabel : "Draft actions"}
        >
          {hasDestinationChoices ? <>
            <span className="max-w-40 truncate">{hasGroups ? groupLabel : workspaceLabel}</span>
            <ChevronDown data-icon="inline-end" />
          </> : <MoreHorizontal />}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          {hasGroups ? <DropdownMenuGroup>
            <DropdownMenuLabel>{workspaceLabel}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={props.destination.groupId ?? ""}>
              <DropdownMenuRadioItem closeOnClick value="" onClick={() => props.onChange({ ...props.destination, groupId: undefined })}>No group</DropdownMenuRadioItem>
              {props.groups.map((group) => <DropdownMenuRadioItem closeOnClick key={group.id} value={group.id} onClick={() => props.onChange({ ...props.destination, groupId: group.id })}>
                {group.label}
              </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup> : null}
          {canChooseWorkspace ? <>
            {hasGroups ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspace</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={props.destination.workspaceId}>
                {workspaces.map((workspace) => <DropdownMenuRadioItem closeOnClick key={workspace.id} value={workspace.id} onClick={() => props.onChange({ workspaceId: workspace.id, parent: props.destination.parent })}>
                  {workspace.label}
                </DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </> : null}
          {props.hasDraft ? <>
            {hasDestinationChoices ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onClick={props.onDiscard}>
                <Trash2 />
                Discard draft
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
