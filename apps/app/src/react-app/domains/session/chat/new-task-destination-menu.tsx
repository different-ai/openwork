import { useRef, useState } from "react";
import { Check, ChevronDown, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { WorkspaceAvatar } from "@/react-app/design-system/workspace-avatar";
import { useWorkspaceAvatarPreference } from "../sidebar/workspace-avatar-store";
import type { NewSessionDestination } from "./new-session-destination";
import {
  buildDestinationOptions,
  destinationLabel,
  destinationWorkspaces,
  type DestinationOption,
} from "./new-task-destination-options";

type Named = { id: string; label: string };

type Props = {
  destination: NewSessionDestination;
  workspaces: Named[];
  /** Groups of every offered workspace, so one pick can choose both. */
  groupsByWorkspace: Record<string, Named[]>;
  hasDraft: boolean;
  /** The draft holds workspace files, so it may only change group within its workspace. */
  workspaceChangeBlocked: boolean;
  disabled: boolean;
  onChange: (destination: NewSessionDestination) => void;
  onDiscard: () => void;
};

const FIND_LABEL = "Find a workspace or group";

/** Quiet context beside the model picker; no destination UI until there is a choice to make. */
export function NewTaskDestinationMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const workspaces = destinationWorkspaces(props.destination, props.workspaces);
  const hasGroups = workspaces.some((workspace) => (props.groupsByWorkspace[workspace.id]?.length ?? 0) > 0);
  const canChooseWorkspace = workspaces.length > 1;
  if (!hasGroups && !canChooseWorkspace) {
    return props.hasDraft ? <DraftActionsMenu disabled={props.disabled} onDiscard={props.onDiscard} /> : null;
  }

  const label = destinationLabel(props.destination, workspaces, props.groupsByWorkspace);
  const options = buildDestinationOptions({
    destination: props.destination,
    workspaces,
    groupsByWorkspace: props.groupsByWorkspace,
    query,
    workspaceChangeBlocked: props.workspaceChangeBlocked,
  });
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const choose = (option: DestinationOption) => {
    if (option.disabled) return;
    close();
    props.onChange({ workspaceId: option.workspaceId, groupId: option.groupId, parent: props.destination.parent });
  };

  return (
    <span className="min-w-0 max-w-full text-muted-foreground">
      <Popover open={open} onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}>
        <PopoverTrigger
          render={<Button variant="ghost" size="xs" />}
          disabled={props.disabled}
          aria-label={`Where this task goes: ${label}`}
          title={label}
          data-new-task-destination=""
        >
          <span className="max-w-56 truncate">{label}</span>
          <ChevronDown data-icon="inline-end" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          initialFocus={inputRef}
          className="flex max-h-[min(var(--available-height),24rem)] w-72 max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-[14px] bg-popover p-0 shadow-[var(--dls-shell-shadow)] ring-0 data-open:animate-none data-closed:animate-none dark:ring-0"
        >
          {/* Without `items`, Base UI keeps its old highlight index when rows filter. */}
          <Command mode="none" items={options.map((option) => option.value)} value={query} onValueChange={(value) => setQuery(value)}>
            <div className="flex h-11 shrink-0 items-center border-b border-gray-3 px-1.5">
              <CommandInput
                ref={inputRef}
                autoFocus={false}
                placeholder={FIND_LABEL}
                aria-label={FIND_LABEL}
                className="h-9 text-[13px] sm:text-[13px]"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
              {props.workspaceChangeBlocked && canChooseWorkspace ? (
                <p className="px-3.5 pt-2.5 text-xs text-gray-10">Remove workspace files to move this draft to another workspace.</p>
              ) : null}
              {options.length === 0 ? (
                <p role="status" className="px-3.5 pb-1 pt-3 text-[13px] text-gray-10">No workspace or group matches.</p>
              ) : null}
              <CommandList className="not-empty:p-1.5">
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    data-new-task-destination-option={option.kind}
                    data-selected={option.selected ? "" : undefined}
                    className={cn(
                      "min-h-8 gap-2 rounded-lg px-2 py-0 text-[13px] data-highlighted:bg-gray-3 data-highlighted:text-gray-12 data-disabled:opacity-50",
                      option.kind === "workspace" ? "font-medium text-gray-12" : "ps-8 text-gray-11",
                    )}
                    onClick={() => choose(option)}
                  >
                    {option.kind === "workspace" ? <DestinationWorkspaceAvatar workspaceId={option.workspaceId} label={option.label} /> : null}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.selected ? <Check className="size-4 shrink-0 text-gray-12" aria-label="Selected" /> : null}
                  </CommandItem>
                ))}
              </CommandList>
            </div>
            {props.hasDraft ? (
              <div className="shrink-0 border-t border-gray-3 p-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-destructive hover:text-destructive"
                  onClick={() => {
                    close();
                    props.onDiscard();
                  }}
                >
                  <Trash2 />
                  Discard draft
                </Button>
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
    </span>
  );
}

function DestinationWorkspaceAvatar({ workspaceId, label }: { workspaceId: string; label: string }) {
  const preference = useWorkspaceAvatarPreference(workspaceId);
  return (
    <WorkspaceAvatar
      workspaceId={workspaceId}
      label={label}
      sizeClass="size-4"
      color={preference?.color}
      imageUrl={preference?.imageUrl}
    />
  );
}

/** Only a draft to discard and nowhere else to send it. */
function DraftActionsMenu({ disabled, onDiscard }: { disabled: boolean; onDiscard: () => void }) {
  return (
    <span className="min-w-0 max-w-full text-muted-foreground">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-xs" />}
          disabled={disabled}
          aria-label="Draft actions"
          title="Draft actions"
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuItem variant="destructive" onClick={onDiscard}>
            <Trash2 />
            Discard draft
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
