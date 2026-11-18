/** @jsxImportSource react */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  OpencodeConnectionImportResult,
  OpencodeConnectionPreviewItem,
  OpencodeConnectionsPreview,
} from "@/app/lib/opencode-connections-import";
import { t } from "@/i18n";

export type OpencodeConnectionsImportSource = {
  /** Identifies the workspace the preview belongs to. */
  workspaceId: string;
  preview: () => Promise<OpencodeConnectionsPreview>;
  importConnections: (names: string[]) => Promise<OpencodeConnectionImportResult[]>;
  /** Reload the connection list so imported connections show their real state. */
  onImported?: () => void;
};

export type OpencodeImportRow = {
  name: string;
  /** What to say beside the name: the connection's state, or why it was not imported. */
  detail: string;
  blocked: boolean;
  /** False for a connection that is ready, which needs nothing from the person. */
  attention: boolean;
};

/** Rows for entries that cannot be imported as they are. */
export function opencodeImportProblemRows(items: OpencodeConnectionPreviewItem[]): OpencodeImportRow[] {
  return items.flatMap((item): OpencodeImportRow[] => {
    if (item.status === "blocked") return [{ name: item.name, detail: t("opencode_import.blocked"), blocked: true, attention: true }];
    if (item.status === "invalid") return [{ name: item.name, detail: item.reason ?? t("opencode_import.invalid"), blocked: false, attention: true }];
    return [];
  });
}

/** One row per result: the real state of each imported connection, then what was left out and why. */
export function opencodeImportReceiptRows(
  results: OpencodeConnectionImportResult[],
  stateOf: (name: string) => { label: string; ready: boolean } | null,
): OpencodeImportRow[] {
  return results.flatMap((result): OpencodeImportRow[] => {
    if (result.status === "already_present") return [];
    if (result.status === "imported") {
      const state = stateOf(result.name);
      return [{ name: result.name, detail: state?.label ?? t("opencode_import.checking"), blocked: false, attention: state ? !state.ready : false }];
    }
    if (result.status === "blocked") return [{ name: result.name, detail: t("opencode_import.blocked"), blocked: true, attention: true }];
    return [{ name: result.name, detail: result.message ?? t("opencode_import.invalid"), blocked: false, attention: true }];
  });
}

function Rows(props: { rows: OpencodeImportRow[] }) {
  if (props.rows.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 border-t border-dls-border pt-2">
      {props.rows.map((row) => (
        <li key={row.name} data-testid={`opencode-import-row-${row.name}`} className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
          {row.blocked ? <Lock size={12} className="shrink-0 text-dls-secondary" aria-hidden /> : null}
          <span className="truncate font-medium text-dls-text">{row.name}</span>
          <span className={row.attention && !row.blocked ? "truncate text-dls-text" : "truncate text-dls-secondary"}>{row.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings → connections: says how many connections the person set up in
 * OpenCode are not in OpenWork and imports them on request. After an import
 * it lists each connection's real state and whatever was left out.
 * Renders nothing when OpenCode has nothing to bring over.
 */
export function OpencodeConnectionsImport(props: {
  source: OpencodeConnectionsImportSource;
  /** The live state of a connection OpenWork has; null while it is not listed yet. */
  stateOf: (name: string) => { label: string; ready: boolean } | null;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["opencode-import", "connections", props.source.workspaceId];
  const preview = useQuery({ queryKey, queryFn: props.source.preview, enabled: Boolean(props.source.workspaceId), retry: false });
  const [results, setResults] = useState<OpencodeConnectionImportResult[] | null>(null);
  const importing = useMutation({
    mutationFn: props.source.importConnections,
    onSuccess: async (next) => {
      setResults(next);
      props.source.onImported?.();
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  if (results) {
    const imported = results.filter((result) => result.status === "imported").length;
    return (
      <div data-testid="opencode-import-receipt" className="mb-5 rounded-xl border border-dls-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-dls-text">{t("opencode_import.imported", { count: imported })}</p>
          <Button variant="ghost" size="sm" onClick={() => setResults(null)}>{t("opencode_import.done")}</Button>
        </div>
        <Rows rows={opencodeImportReceiptRows(results, props.stateOf)} />
      </div>
    );
  }

  const items = preview.data?.items ?? [];
  const fresh = items.filter((item) => item.status === "new");
  const problems = opencodeImportProblemRows(items);
  if (fresh.length === 0 && problems.length === 0) return null;

  return (
    <div data-testid="opencode-import" className="mb-5 rounded-xl border border-dls-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-dls-text">
            {fresh.length > 0
              ? t("opencode_import.found", { count: fresh.length })
              : t("opencode_import.none_importable", { count: problems.length })}
          </p>
          {fresh.length > 0 ? <p className="truncate text-xs leading-5 text-dls-secondary">{fresh.map((item) => item.name).join(", ")}</p> : null}
        </div>
        {fresh.length > 0 ? (
          <Button
            size="sm"
            className="shrink-0"
            data-testid="opencode-import-action"
            disabled={importing.isPending}
            onClick={() => importing.mutate(fresh.map((item) => item.name))}
          >
            {importing.isPending ? t("opencode_import.importing") : t("opencode_import.action")}
          </Button>
        ) : null}
      </div>
      <Rows rows={problems} />
      {importing.isError ? <p className="mt-2 text-xs text-red-11">{t("opencode_import.failed")}</p> : null}
    </div>
  );
}
