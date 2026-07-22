/** @jsxImportSource react */
import * as React from "react";
import { BrainCircuit, Copy, RefreshCw, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import type { DenMemory } from "@/app/lib/den";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import {
  SettingsList,
  SettingsListItem,
  SettingsListItemActions,
  SettingsListItemContent,
  SettingsListItemDescription,
  SettingsListItemTitle,
} from "@/react-app/domains/settings/settings-list";
import { SettingsNotice, SettingsStack } from "@/react-app/domains/settings/settings-section";
import { visibleMemories } from "./memory-utils";

// The server delete is deferred so "Undo" is a true reversal (no re-create; original id/
// timestamps preserved). The undo toast dismisses BEFORE the delete fires, so a user is
// never offered an undo that can no longer reverse the delete.
const UNDO_DELETE_DELAY_MS = 6000;
const UNDO_TOAST_DURATION_MS = 5000;

// Secondary cross-tool utility (Claude Code / external harnesses): on desktop the agent is
// already primed by the injected `## Memory Bank` prompt, so this is not the first-run path.
const COPY_SAVE_PROMPT =
  "Save this to my memory bank: draft a crisp, self-contained memory of the key fact worth keeping from our conversation, show it to me to confirm or edit, then save it. Do not include any secrets, credentials, tokens, or personal data.";

export type MemoryViewProps = {
  onOpenAccount: () => void;
};

export function MemoryView({ onOpenAccount }: MemoryViewProps) {
  const { activeOrganization, authToken, client, isSignedIn } = useCloudSession();
  const queryClient = useQueryClient();
  const activeOrgId = activeOrganization?.id ?? "";
  const queryKey = React.useMemo(() => ["memory", activeOrgId] as const, [activeOrgId]);

  const memoriesQuery = useQuery<DenMemory[]>({
    queryKey,
    enabled: Boolean(authToken.trim() && activeOrgId),
    queryFn: () => client.listMemory(activeOrgId),
    staleTime: 30_000,
  });

  // Optimistic-delete "veil": ids removed from the UI while their server delete is deferred.
  // The query cache keeps the real server list, so a refetch can't resurrect a mid-delete row.
  const [pendingDeleteIds, setPendingDeleteIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [confirmTarget, setConfirmTarget] = React.useState<DenMemory | null>(null);
  const [copied, setCopied] = React.useState(false);

  type PendingDelete = { timer: ReturnType<typeof setTimeout>; flush: () => void };
  const timersRef = React.useRef<Map<string, PendingDelete> | null>(null);
  if (!timersRef.current) timersRef.current = new Map();
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(true);
  const toolbarRef = React.useRef<HTMLDivElement | null>(null);

  const unveil = React.useCallback((id: string) => {
    setPendingDeleteIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const performDelete = React.useCallback(
    (memory: DenMemory) => {
      const timers = timersRef.current;
      if (!timers) return;
      // Capture org/client/key NOW so the deferred delete (timer OR unmount flush) always targets
      // the org the user deleted in — even if they switch orgs during the undo window.
      const capturedOrgId = activeOrgId;
      const capturedClient = client;
      const capturedKey = ["memory", capturedOrgId] as const;
      const toastKey = `memory-delete-${memory.id}`;

      const existing = timers.get(memory.id);
      if (existing) clearTimeout(existing.timer);
      setPendingDeleteIds((prev) => new Set(prev).add(memory.id));

      const commit = async () => {
        timers.delete(memory.id);
        try {
          await capturedClient.deleteMemory(capturedOrgId, memory.id);
          // Committed on the server: drop it from the cache and lift the veil.
          queryClient.setQueryData<DenMemory[]>(capturedKey, (prev) => (prev ?? []).filter((m) => m.id !== memory.id));
          if (mountedRef.current) unveil(memory.id);
        } catch (error) {
          if (mountedRef.current) {
            unveil(memory.id); // restore visibility — the delete did not stick
            toast.error(error instanceof Error ? error.message : t("memory.delete_error"));
          }
        }
        // Retire the undo toast so its button can never outlive the delete (e.g. if hovered).
        toast.dismiss(toastKey);
      };

      const timer = setTimeout(() => void commit(), UNDO_DELETE_DELAY_MS);
      timers.set(memory.id, { timer, flush: () => void commit() });

      toast.success(t("memory.deleted"), {
        id: toastKey,
        duration: UNDO_TOAST_DURATION_MS,
        action: {
          label: t("memory.undo"),
          onClick: () => {
            const pending = timers.get(memory.id);
            if (!pending) return; // already committed — undo can no longer reverse it
            clearTimeout(pending.timer);
            timers.delete(memory.id);
            unveil(memory.id);
            toast.dismiss(toastKey);
          },
        },
      });

      // Focus the toolbar (which persists across the list <-> empty transition) AFTER the confirm
      // modal closes and restores focus, so keyboard users are not stranded on the removed row.
      requestAnimationFrame(() => toolbarRef.current?.focus());
    },
    [activeOrgId, client, queryClient, unveil],
  );

  // On unmount, flush pending deletes so they persist even if the user navigates away during the
  // undo window. Each flush uses the org/client captured when its delete was queued (not live refs).
  React.useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (timers) {
        for (const { timer, flush } of timers.values()) {
          clearTimeout(timer);
          flush();
        }
        timers.clear();
      }
    };
  }, []);

  const copyPrompt = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(COPY_SAVE_PROMPT);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
      toast.success(t("memory.copy_prompt_copied"));
    } catch {
      toast.error(t("memory.copy_prompt_error"));
    }
  }, []);

  if (!isSignedIn) {
    return (
      <SettingsStack>
        <Separator />
        <SettingsNotice>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("memory.sign_in_hint")}</span>
            <Button size="sm" onClick={onOpenAccount}>
              {t("memory.sign_in_cta")}
            </Button>
          </div>
        </SettingsNotice>
      </SettingsStack>
    );
  }

  if (!activeOrgId) {
    return (
      <SettingsStack>
        <Separator />
        <SettingsNotice>{t("memory.no_active_org")}</SettingsNotice>
      </SettingsStack>
    );
  }

  const memories = visibleMemories(memoriesQuery.data ?? [], pendingDeleteIds);
  const isLoading = memoriesQuery.isLoading;
  const errorMessage = memoriesQuery.isError
    ? memoriesQuery.error instanceof Error
      ? memoriesQuery.error.message
      : t("memory.error_load")
    : null;

  return (
    <SettingsStack>
      <Separator />

      <div
        ref={toolbarRef}
        tabIndex={-1}
        className="flex flex-col gap-3 outline-none sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="text-sm text-muted-foreground">{t("memory.description")}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={copyPrompt}
            title={t("memory.copy_prompt_hint")}
            aria-label={t("memory.copy_prompt")}
          >
            <Copy className="size-4" />
            {copied ? t("memory.copy_prompt_copied") : t("memory.copy_prompt")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void memoriesQuery.refetch()}
            disabled={memoriesQuery.isFetching}
            title={t("memory.refresh")}
            aria-label={t("memory.refresh")}
          >
            <RefreshCw className={cn("size-4", memoriesQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {errorMessage ? <SettingsNotice tone="error">{errorMessage}</SettingsNotice> : null}

      {isLoading ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !errorMessage && memories.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <BrainCircuit className="text-muted-foreground" />
            </EmptyMedia>
            <EmptyTitle>{t("memory.empty_title")}</EmptyTitle>
            <EmptyDescription>{t("memory.empty_description")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SettingsList>
          {memories.map((memory) => (
            <SettingsListItem key={memory.id}>
              <SettingsListItemContent>
                {/* React escapes text children, so stored content renders safely (stored-XSS guard). */}
                <SettingsListItemTitle>{memory.content}</SettingsListItemTitle>
                {memory.contexts.length > 0 ? (
                  <SettingsListItemDescription>
                    <span className="text-muted-foreground">{t("memory.provenance_label")}</span>{" "}
                    {memory.contexts.map((context) => context.snippet).join(" · ")}
                  </SettingsListItemDescription>
                ) : null}
                {memory.tags && memory.tags.length > 0 ? (
                  <SettingsListItemDescription>{memory.tags.join(", ")}</SettingsListItemDescription>
                ) : null}
              </SettingsListItemContent>
              <SettingsListItemActions>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setConfirmTarget(memory)}
                  title={t("memory.delete")}
                  aria-label={t("memory.delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </SettingsListItemActions>
            </SettingsListItem>
          ))}
        </SettingsList>
      )}

      <ConfirmModal
        open={confirmTarget !== null}
        variant="danger"
        title={t("memory.delete_confirm_title")}
        message={t("memory.delete_confirm_message")}
        confirmLabel={t("memory.delete_confirm_cta")}
        cancelLabel={t("memory.cancel")}
        onConfirm={() => {
          if (confirmTarget) performDelete(confirmTarget);
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </SettingsStack>
  );
}
