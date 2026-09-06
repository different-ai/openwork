import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hand, LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import type { OpenworkServerClient, WorkspaceRunMode } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useFeatureFlagsPreferences } from "@/react-app/domains/settings/state/feature-flags-preferences";

type Props = { client: OpenworkServerClient | null; workspaceId: string | null; busy: boolean };

const modes = [
  { value: "approve", label: "Ask before actions", description: "Pause for tool approval unless a workspace rule allows it.", icon: Hand },
  { value: "default", label: "Workspace defaults", description: "Use your existing setup to decide when to ask.", icon: ShieldCheck },
  { value: "run-everything", label: "Keep going", description: "Allow tools by default, including files outside this workspace.", icon: ShieldAlert },
] satisfies { value: WorkspaceRunMode; label: string; description: string; icon: typeof Hand }[];

export function WorkspaceRunModeMenu(props: Props) {
  const { workspaceRunModeEnabled } = useFeatureFlagsPreferences();
  const restricted = useDesktopRestriction("allowControlSettings");
  if (!workspaceRunModeEnabled || restricted || !isDesktopRuntime() || !props.client || !props.workspaceId) return null;
  // Remount on endpoint/workspace changes so a pending confirmation cannot
  // apply the previous pane's choice to a newly selected workspace.
  return <WorkspaceRunModePicker key={`${props.client.baseUrl}:${props.workspaceId}`} client={props.client} workspaceId={props.workspaceId} busy={props.busy} />;
}

function WorkspaceRunModePicker({ client, workspaceId, busy }: { client: OpenworkServerClient; workspaceId: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = ["workspace-run-mode", client.baseUrl, workspaceId];
  const mode = useQuery({ queryKey, queryFn: () => client.getWorkspaceRunMode(workspaceId), retry: false });
  const mutation = useMutation({
    mutationKey: queryKey,
    mutationFn: (value: WorkspaceRunMode) => client.setWorkspaceRunMode(workspaceId, value),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
      setConfirm(false);
      setOpen(false);
      if (result.refreshPending) toast.warning(result.reason ?? "Saved. Reload this workspace before relying on the new mode.");
      else toast.success("Workspace run mode updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message);
      void mode.refetch();
    },
  });
  const selected = modes.find((item) => item.value === mode.data?.mode);
  const label = mode.isError ? "Unavailable" : selected?.label ?? (mode.isPending ? "Loading" : "Custom rules");
  const Icon = mode.data?.supported === false || mode.isError || mode.data?.refreshPending ? ShieldAlert : selected?.icon ?? ShieldCheck;
  const locked = busy || mutation.isPending || mode.isFetching || !mode.data?.supported;
  const select = (value: unknown) => {
    if (locked || (value !== "default" && value !== "approve" && value !== "run-everything")) return;
    if (value === "run-everything") {
      setOpen(false);
      setConfirm(true);
    } else mutation.mutate(value);
  };
  return (
    <>
      <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) void mode.refetch(); }}>
        <DropdownMenuTrigger
          data-testid="workspace-run-mode-trigger"
          aria-label={`Workspace run mode: ${label}${mode.data?.refreshPending ? " (refresh pending)" : ""}`}
          title={`Workspace run mode: ${label}${mode.data?.refreshPending ? " — refresh pending" : ""}`}
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-gray-3 ${mode.data?.mode === "run-everything" || mode.data?.refreshPending ? "text-orange-600 dark:text-orange-400" : "text-gray-10"}`}
        >
          {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className="size-4" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" sideOffset={10} className="w-[min(390px,calc(100vw-32px))] p-2">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-3 text-sm">How should OpenWork handle approvals?</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mode.data?.mode ?? ""}>
              {modes.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value} onClick={() => select(item.value)} aria-label={item.label} data-testid={`run-mode-${item.value}`} disabled={locked} className={`gap-3 py-3 ${item.value === "run-everything" ? "text-orange-600 dark:text-orange-400" : ""}`}>
                  <item.icon className="size-5" />
                  <span className="min-w-0">
                    <span className="block">{item.label}</span>
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{item.description}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <p className="px-3 py-2 text-xs text-muted-foreground">Applies to every chat in this workspace. Specific workspace rules still apply.</p>
          {busy ? <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">Wait for this workspace to finish before changing its mode.</p> : null}
          {mode.isError ? <p role="alert" className="px-3 pb-2 text-xs text-destructive">Run modes are unavailable. {mode.error.message}</p> : null}
          {mode.data?.reason ? <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">{mode.data.reason}</p> : null}
          {mode.data?.refreshPending ? <p role="status" className="px-3 pb-2 text-xs text-orange-600">Saved, but engine refresh is pending. Select the mode again to retry.</p> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let OpenWork keep going?</AlertDialogTitle>
            <AlertDialogDescription>
              This changes every chat in this workspace. Tools can edit or delete files, run commands, and use the network without approval, including outside authorized folders. It can override global permission rules and repeated-action prompts. Specific workspace rules still apply; it does not grant operating-system or service access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={locked} onClick={() => mutation.mutate("run-everything")}>Enable Keep going</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
