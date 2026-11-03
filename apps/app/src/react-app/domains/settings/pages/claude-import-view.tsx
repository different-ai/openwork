/** @jsxImportSource react */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Lock } from "lucide-react";

import { ProviderIcon } from "@/react-app/design-system/provider-icon";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  claudeImportItemsSchema,
  claudeImportResultsSchema,
  type ClaudeImportItem,
  type ClaudeImportResult,
} from "@/app/lib/claude-import";
import { openDesktopUrl } from "@/app/lib/desktop";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SettingsNotice } from "../settings-section";
import {
  SettingsList,
  SettingsListEmptyState,
  SettingsListItem,
  SettingsListItemActions,
  SettingsListItemContent,
  SettingsListItemDescription,
  SettingsListItemTitle,
} from "../settings-list";
import {
  LayoutSectionItem,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";

export const CLAUDE_IMPORT_GUIDE_URL = "https://openworklabs.com/docs/start-here/import-claude-history";

export type ClaudeImportViewProps = {
  client: OpenworkServerClient | null;
  workspaceId: string;
  onOpenSession: (sessionId: string) => void;
};

/**
 * Settings → Import: brings Claude Code sessions saved for this folder and
 * chats from a Claude data export into the workspace as regular chats.
 */
export function ClaudeImportView(props: ClaudeImportViewProps) {
  return (
    <LayoutStack>
      <ClaudeCodeSection {...props} />
      <Separator />
      <ClaudeExportSection {...props} />
      <Separator />
      <CoworkRow />
    </LayoutStack>
  );
}

/** Section title with Claude's own mark, since every row in it came from Claude. */
function SectionTitle(props: { children: string }) {
  return (
    <LayoutSectionItemTitle className="flex items-center gap-2">
      <ProviderIcon providerId="anthropic" size={16} />
      {props.children}
    </LayoutSectionItemTitle>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t("claude_import.read_failed");
}

function ClaudeCodeSection(props: ClaudeImportViewProps) {
  const queryClient = useQueryClient();
  const queryKey = ["claude-import", "code", props.workspaceId];
  const sessions = useQuery({
    queryKey,
    enabled: Boolean(props.client && props.workspaceId),
    queryFn: async () => {
      if (!props.client) return [];
      return props.client.listClaudeCodeSessions(props.workspaceId);
    },
  });
  // Sessions not imported yet start ticked: the person came here to bring them over.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ClaudeImportResult>>(new Map());
  const selected = useMemo(
    () => new Set((sessions.data ?? []).filter((item) => item.status === "new" && !excluded.has(item.sourceId) && !results.has(item.sourceId)).map((item) => item.sourceId)),
    [sessions.data, excluded, results],
  );
  const setSelected = (next: Set<string>) =>
    setExcluded(new Set((sessions.data ?? []).filter((item) => item.status === "new" && !next.has(item.sourceId)).map((item) => item.sourceId)));
  const importing = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!props.client) return [];
      return props.client.importClaudeCodeSessions(props.workspaceId, ids);
    },
    onSuccess: async (next) => {
      setResults(new Map(next.map((result) => [result.sourceId, result])));
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <SectionTitle>{t("claude_import.code_title")}</SectionTitle>
        {selected.size > 0 || importing.isPending ? (
          <LayoutSectionItemHeaderActions>
            <Button size="sm" disabled={importing.isPending} onClick={() => importing.mutate([...selected])}>
              {importing.isPending
                ? t("claude_import.importing")
                : t("claude_import.import_sessions", { count: selected.size })}
            </Button>
          </LayoutSectionItemHeaderActions>
        ) : null}
      </LayoutSectionItemHeader>
      {sessions.isPending ? (
        <ImportListSkeleton />
      ) : sessions.isError ? (
        <SettingsNotice tone="error">
          {errorMessage(sessions.error)}{" "}
          <Button variant="link" size="xs" onClick={() => void sessions.refetch()}>{t("claude_import.try_again")}</Button>
        </SettingsNotice>
      ) : sessions.data.length === 0 ? (
        <SettingsListEmptyState>{t("claude_import.code_empty")}</SettingsListEmptyState>
      ) : (
        <ImportList
          items={sessions.data}
          selected={selected}
          onSelectedChange={setSelected}
          results={results}
          onOpenSession={props.onOpenSession}
        />
      )}
      {importing.isError ? <SettingsNotice tone="error">{errorMessage(importing.error)}</SettingsNotice> : null}
    </LayoutSectionItem>
  );
}

function ClaudeExportSection(props: ClaudeImportViewProps) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [items, setItems] = useState<ClaudeImportItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ClaudeImportResult>>(new Map());

  const reading = useMutation({
    mutationFn: async (next: File) => {
      if (!props.client) return [];
      return claudeImportItemsSchema.parse(await props.client.readClaudeExport(props.workspaceId, next)).items;
    },
    onSuccess: (next) => {
      setItems(next);
      setResults(new Map());
      setSelected(new Set(next.filter((item) => item.status === "new").map((item) => item.sourceId)));
    },
  });
  const importing = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!props.client || !file) return [];
      return claudeImportResultsSchema.parse(await props.client.readClaudeExport(props.workspaceId, file, { importIds: ids })).results;
    },
    onSuccess: (next) => {
      setResults(new Map(next.map((result) => [result.sourceId, result])));
      setSelected(new Set());
      setItems((current) =>
        current?.map((item) => {
          const result = next.find((entry) => entry.sourceId === item.sourceId);
          return result && (result.status === "imported" || result.status === "already_imported") ? { ...item, status: "imported" } : item;
        }) ?? null,
      );
    },
  });

  const [dragging, setDragging] = useState(false);
  const choose = (next: File | undefined) => {
    if (!next || !props.client) return;
    setFile(next);
    setItems(null);
    reading.mutate(next);
  };

  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <SectionTitle>{t("claude_import.chats_title")}</SectionTitle>
        <LayoutSectionItemHeaderActions>
          <input
            ref={input}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            className="hidden"
            data-testid="claude-import-file"
            onChange={(event) => {
              choose(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!props.client || reading.isPending || importing.isPending}
            onClick={() => input.current?.click()}
          >
            {file ? t("claude_import.choose_another_file") : t("claude_import.choose_export")}
          </Button>
          {items && (selected.size > 0 || importing.isPending) ? (
            <Button size="sm" disabled={importing.isPending} onClick={() => importing.mutate([...selected])}>
              {importing.isPending
                ? t("claude_import.importing")
                : t("claude_import.import_chats", { count: selected.size })}
            </Button>
          ) : null}
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
      {reading.isPending ? (
        <ImportListSkeleton />
      ) : reading.isError ? (
        <SettingsNotice tone="error">{errorMessage(reading.error)}</SettingsNotice>
      ) : null}
      {items ? (
        <>
          <SettingsListItemDescription className="px-3">{file?.name}</SettingsListItemDescription>
          <ImportList
            items={items}
            selected={selected}
            onSelectedChange={setSelected}
            results={results}
            onOpenSession={props.onOpenSession}
          />
          <SettingsNotice>{t("claude_import.export_scope_notice")}</SettingsNotice>
        </>
      ) : reading.isPending ? null : (
        <div
          data-testid="claude-import-drop"
          data-dragging={dragging || undefined}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            choose(event.dataTransfer.files[0]);
          }}
          className={cn(
            "flex flex-col items-center gap-1 rounded-2xl border border-dashed border-dls-border px-4 py-6 text-center transition-colors",
            dragging && "border-dls-text/40 bg-dls-hover",
          )}
        >
          <span className="text-sm text-dls-text">{t("claude_import.drop_title")}</span>
          <span className="text-xs text-muted-foreground">{t("claude_import.drop_hint")}</span>
        </div>
      )}
      {importing.isError ? <SettingsNotice tone="error">{errorMessage(importing.error)}</SettingsNotice> : null}
      <ExportHowTo />
    </LayoutSectionItem>
  );
}

function ExportHowTo() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1 px-3 text-xs text-muted-foreground hover:text-dls-text"
          />
        }
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {t("claude_import.how_to_title")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-9 pr-3 text-xs text-muted-foreground">
          <li>{t("claude_import.how_to_step_1")}</li>
          <li>{t("claude_import.how_to_step_2")}</li>
          <li>{t("claude_import.how_to_step_3")}</li>
          <li>{t("claude_import.how_to_step_4")}</li>
        </ol>
        <Button variant="link" size="xs" className="ml-6 mt-1" onClick={() => void openDesktopUrl(CLAUDE_IMPORT_GUIDE_URL)}>
          {t("claude_import.open_guide")}
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CoworkRow() {
  return (
    <SettingsListItem className="border-0 px-0 hover:bg-transparent">
      <SettingsListItemContent>
        <span className="flex items-center gap-2 font-medium text-dls-text">
          <Lock className="size-3.5 text-muted-foreground" aria-hidden />
          {t("claude_import.cowork_title")}
        </span>
        <SettingsListItemDescription className="whitespace-normal">{t("claude_import.cowork_state")}</SettingsListItemDescription>
      </SettingsListItemContent>
      <SettingsListItemActions>
        <Button variant="outline" size="sm" onClick={() => void openDesktopUrl(`${CLAUDE_IMPORT_GUIDE_URL}#cowork-tasks`)}>
          {t("claude_import.learn_more")}
        </Button>
      </SettingsListItemActions>
    </SettingsListItem>
  );
}

function ImportListSkeleton() {
  return (
    <SettingsList>
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-3 px-3 py-2">
          <Skeleton className="size-4 rounded-[5px]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </SettingsList>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function ImportList(props: {
  items: ClaudeImportItem[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  results: Map<string, ClaudeImportResult>;
  onOpenSession: (sessionId: string) => void;
}) {
  const importable = useMemo(() => props.items.filter((item) => item.status === "new" && props.results.get(item.sourceId)?.status !== "imported"), [props.items, props.results]);
  const allSelected = importable.length > 0 && importable.every((item) => props.selected.has(item.sourceId));
  const toggle = (sourceId: string, checked: boolean) => {
    const next = new Set(props.selected);
    if (checked) next.add(sourceId);
    else next.delete(sourceId);
    props.onSelectedChange(next);
  };

  return (
    <div className="flex flex-col gap-1">
      {importable.length > 1 ? (
        <label className="flex items-center gap-3 px-3 py-1 text-xs text-muted-foreground">
          <Checkbox
            checked={allSelected}
            onCheckedChange={(checked) => props.onSelectedChange(new Set(checked ? importable.map((item) => item.sourceId) : []))}
          />
          {t("claude_import.select_all")}
        </label>
      ) : null}
      <SettingsList className="max-h-80 gap-y-0.5 overflow-y-auto">
        {props.items.map((item) => {
          const result = props.results.get(item.sourceId);
          const imported = item.status === "imported" || result?.status === "imported" || result?.status === "already_imported";
          const failed = result?.status === "failed";
          const checkable = item.status === "new" && !imported;
          return (
            <SettingsListItem key={item.sourceId} className="min-h-11 gap-3">
              <label className="flex min-w-0 flex-1 items-center gap-3">
                <Checkbox
                  checked={props.selected.has(item.sourceId)}
                  disabled={!checkable}
                  onCheckedChange={(checked) => toggle(item.sourceId, checked)}
                  aria-label={item.title}
                />
                <SettingsListItemContent>
                  <SettingsListItemTitle>{item.title}</SettingsListItemTitle>
                  <SettingsListItemDescription>
                    {t("claude_import.item_meta", { count: item.messageCount, date: dateFormat.format(new Date(item.updatedAt)) })}
                  </SettingsListItemDescription>
                </SettingsListItemContent>
              </label>
              <SettingsListItemActions>
                {imported ? (
                  <>
                    <span className="text-xs text-muted-foreground">{t("claude_import.state_imported")}</span>
                    <Button variant="outline" size="sm" onClick={() => props.onOpenSession(result?.sessionId ?? item.sessionId)}>
                      {t("claude_import.open")}
                    </Button>
                  </>
                ) : failed ? (
                  <span className="text-xs text-red-11" title={result?.message}>{t("claude_import.state_failed")}</span>
                ) : item.status === "changed" || result?.status === "skipped_changed" ? (
                  <span className="text-xs text-muted-foreground" title={t("claude_import.state_changed_hint")}>{t("claude_import.state_changed")}</span>
                ) : null}
              </SettingsListItemActions>
            </SettingsListItem>
          );
        })}
      </SettingsList>
    </div>
  );
}
