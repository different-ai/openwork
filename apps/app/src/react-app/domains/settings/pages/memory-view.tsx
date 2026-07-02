/** @jsxImportSource react */
import * as React from "react";
import { BrainCircuit, Copy, RefreshCw, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
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

// The undo window: the row is removed immediately and the server delete only fires after this
// delay, so "Undo" is a true reversal (no re-create, original id/timestamps preserved).
const UNDO_DELETE_DELAY_MS = 6000;

// Secondary cross-tool utility (Claude Code / external harnesses): on desktop the agent is
// already primed by the injected `## Memory Bank` prompt, so this is not the first-run path.
const COPY_SAVE_PROMPT =
  "Save this to my memory bank: draft a crisp, self-contained memory of the key fact worth keeping from our conversation, show it to me to confirm or edit, then save it. Do not include any secrets, credentials, tokens, or personal data.";

export function byCreatedAtDesc(a: DenMemory, b: DenMemory): number {
  if (a.createdAt < b.createdAt) return 1;
  if (a.createdAt > b.createdAt) return -1;
  return 0;
}

/** Re-insert a memory (undo of an optimistic delete), de-duped and newest-first. */
export function restoreMemory(list: DenMemory[] | undefined, memory: DenMemory): DenMemory[] {
  return [...(list ?? []).filter((entry) => entry.id !== memory.id), memory].sort(byCreatedAtDesc);
}

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

  const [confirmTarget, setConfirmTarget] = React.useState<DenMemory | null>(null);
  const [copied, setCopied] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const pendingDeletes = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const finalizeDelete = React.useCallback(
    async (memory: DenMemory) => {
      pendingDeletes.current.delete(memory.id);
      try {
        await client.deleteMemory(activeOrgId, memory.id);
      } catch (error) {
        // Server delete failed — put the memory back so the UI reflects reality.
        queryClient.setQueryData<DenMemory[]>(queryKey, (prev) => restoreMemory(prev, memory));
        toast.error(error instanceof Error ? error.message : t("memory.delete_error"));
      }
    },
    [activeOrgId, client, queryClient, queryKey],
  );

  const performDelete = React.useCallback(
    (memory: DenMemory) => {
      queryClient.setQueryData<DenMemory[]>(queryKey, (prev) => (prev ?? []).filter((entry) => entry.id !== memory.id));
      // Move focus off the now-removed row so keyboard users are not stranded.
      listRef.current?.focus();
      const timer = setTimeout(() => void finalizeDelete(memory), UNDO_DELETE_DELAY_MS);
      pendingDeletes.current.set(memory.id, timer);
      toast.success(t("memory.deleted"), {
        duration: UNDO_DELETE_DELAY_MS,
        action: {
          label: t("memory.undo"),
          onClick: () => {
            const pending = pendingDeletes.current.get(memory.id);
            if (pending) {
              clearTimeout(pending);
              pendingDeletes.current.delete(memory.id);
            }
            queryClient.setQueryData<DenMemory[]>(queryKey, (prev) => restoreMemory(prev, memory));
          },
        },
      });
    },
    [finalizeDelete, queryClient, queryKey],
  );

  // On unmount, flush any pending deletes so they persist even if the user navigates away
  // during the undo window.
  React.useEffect(() => {
    const pending = pendingDeletes.current;
    return () => {
      for (const [id, timer] of pending) {
        clearTimeout(timer);
        void client.deleteMemory(activeOrgId, id).catch(() => {});
      }
      pending.clear();
    };
  }, [activeOrgId, client]);

  const copyPrompt = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(COPY_SAVE_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
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

  const memories = memoriesQuery.data ?? [];
  const isLoading = memoriesQuery.isLoading;
  const errorMessage = memoriesQuery.isError
    ? memoriesQuery.error instanceof Error
      ? memoriesQuery.error.message
      : t("memory.error_load")
    : null;

  return (
    <SettingsStack>
      <Separator />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
            <RefreshCw className={`size-4${memoriesQuery.isFetching ? " animate-spin" : ""}`} />
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
        <div ref={listRef} tabIndex={-1} className="outline-none">
          <SettingsList>
            {memories.map((memory) => (
              <SettingsListItem key={memory.id}>
                <SettingsListItemContent>
                  {/* React escapes text children, so stored content is rendered safely (stored-XSS guard). */}
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
        </div>
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
