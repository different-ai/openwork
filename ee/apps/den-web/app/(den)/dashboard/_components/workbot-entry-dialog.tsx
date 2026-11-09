"use client";

import { Dialog } from "@base-ui/react/dialog";
import { LockKeyhole } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DenOrgAccessFlags, type DenOrgContext } from "../../_lib/den-org";
import { buttonVariants } from "../../_components/ui/button";
import { decideWorkbotEntry, WORKBOT_ENTRY_COPY, isWorkbotEntryHref, type WorkbotEntry } from "../_lib/workbot-entry";
import { useWorkbotReadiness } from "./workbot-readiness-data";

type BlockedWorkbotEntry = Exclude<WorkbotEntry, { kind: "open" }>;

/** The dialog's one action, for viewers who can fix what blocks Workbot themselves. */
function entryAction(entry: BlockedWorkbotEntry): { href: string; label: string; testId: string } | null {
  if (entry.kind === "add-provider") return { href: entry.href, label: WORKBOT_ENTRY_COPY.addProviderAction, testId: "workbot-entry-dialog-add-provider" };
  if (entry.kind === "off" && entry.teamsHref) return { href: entry.teamsHref, label: WORKBOT_ENTRY_COPY.offAction, testId: "workbot-entry-dialog-open-teams" };
  return null;
}

/**
 * Shown instead of leaving for Workbot when it has no AI provider or an admin turned it off for the viewer. Title only
 * (DESIGN.md P2): the admin's action names the fix, and the member's title says who can change it, with a neutral
 * lock (P4, C5).
 */
export function WorkbotEntryDialog({ entry, open, onOpenChange }: {
  entry: BlockedWorkbotEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const addProvider = entry.kind === "add-provider";
  const action = entryAction(entry);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <Dialog.Popup
          data-testid="workbot-entry-dialog"
          data-entry={entry.kind}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none"
        >
          <div className="flex items-start gap-2.5">
            {addProvider ? null : <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" strokeWidth={1.5} aria-hidden />}
            <Dialog.Title className="text-[15px] font-medium leading-5 text-gray-950">
              {addProvider ? WORKBOT_ENTRY_COPY.addProviderTitle : entry.kind === "off" ? WORKBOT_ENTRY_COPY.offTitle : WORKBOT_ENTRY_COPY.askAdminTitle}
            </Dialog.Title>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close data-testid="workbot-entry-dialog-close" className={buttonVariants({ variant: "secondary" })}>
              {action ? "Not now" : "Close"}
            </Dialog.Close>
            {action ? (
              <Link
                href={action.href}
                data-testid={action.testId}
                onClick={() => onOpenChange(false)}
                className={buttonVariants({ variant: "primary" })}
              >
                {action.label}
              </Link>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The dashboard's Workbot entry. Readiness loads with the dashboard (no "Checking…" step, P11), so a click either
 * goes to Workbot at once or opens the dialog. Off unless Workbot is offered.
 */
export function useWorkbotEntry({ orgId, orgSlug, orgContext, access, enabled }: {
  orgId: string | null;
  orgSlug: string | null;
  orgContext: DenOrgContext | null;
  access: DenOrgAccessFlags;
  enabled: boolean;
}) {
  const pathname = usePathname();
  const readiness = useWorkbotReadiness(orgId, enabled && orgContext?.capabilities.workbot === true);
  const entry = decideWorkbotEntry({ readiness: readiness.data, access, orgSlug });
  const [dialogOpen, setDialogOpen] = useState(false);
  const blocked = entry.kind !== "open";
  const { refetch } = readiness;

  // While blocked, check again as people move around Den (for example after adding a provider, or turning Workbot
  // on for a team), so the next Workbot click uses fresh state. Once Workbot is ready this stops.
  const checkedPathRef = useRef(pathname);
  useEffect(() => {
    if (checkedPathRef.current === pathname) return;
    checkedPathRef.current = pathname;
    if (blocked) void refetch();
  }, [blocked, pathname, refetch]);

  /** True when the navigation to `href` was handled here and the caller must not navigate. */
  const interceptNavigation = useCallback((href: string) => {
    if (!isWorkbotEntryHref(href) || !blocked) return false;
    setDialogOpen(true);
    return true;
  }, [blocked]);

  const dialog = entry.kind === "open"
    ? null
    : <WorkbotEntryDialog entry={entry} open={dialogOpen} onOpenChange={setDialogOpen} />;

  return { entry, interceptNavigation, dialog };
}
