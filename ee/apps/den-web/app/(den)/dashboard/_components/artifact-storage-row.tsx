"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { requestResponse } from "../../_lib/den-flow";
import { artifactStorageRowState, artifactStorageSummarySchema } from "./artifact-storage-state";
import { ItemMenu, ItemRow } from "./item-list";

type ExportFormat = { format: "sqlite" } | { format: "csv"; collection: string };

async function downloadStorage(path: string, format: ExportFormat) {
  const response = await requestResponse(`${path}/export?${new URLSearchParams(format)}`, {
    headers: { Accept: format.format === "sqlite" ? "application/vnd.sqlite3" : "text/csv" },
  });
  if (!response.ok) {
    if (response.status === 413) return "This collection is too large for CSV. Export SQLite instead.";
    return "Couldn't download saved data. Try exporting again.";
  }
  const filename = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1]
    ?? `artifact.${format.format}`;
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

const bytes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatBytes(size: number): string {
  if (size >= 1_000_000) return `${bytes.format(size / 1_000_000)} MB`;
  if (size >= 1_000) return `${bytes.format(size / 1_000)} KB`;
  return `${bytes.format(size)} B`;
}

export function ArtifactStorageRow({ appId, scope, title, logo, href }: { appId: string; scope: string; title: string; logo: ReactNode; href?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/v1/mcp-apps/${encodeURIComponent(appId)}/storage`;
  const summary = useQuery({
    queryKey: ["artifact-storage", scope, appId],
    retry: false,
    queryFn: async () => {
      const response = await requestResponse(path);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Couldn't check saved data.");
      return artifactStorageSummarySchema.parse(await response.json());
    },
  });

  async function exportFile(format: ExportFormat) {
    setBusy(true);
    setError(null);
    try {
      setError((await downloadStorage(path, format)) ?? null);
    } catch {
      setError("Couldn't download saved data. Try exporting again.");
    } finally {
      setBusy(false);
    }
  }

  const state = artifactStorageRowState(summary.data, summary.isError);
  const failure = error ?? (state.kind === "unavailable" ? "Couldn't check saved data. Reload to try again." : null);
  return (
    <ItemRow compact logo={logo} title={title} href={href}
      description={failure ? <span role="alert" title={failure}>{failure}</span> : state.kind === "saved"
        ? `Saved data · ${state.rowCount.toLocaleString()} ${state.rowCount === 1 ? "row" : "rows"} · ${formatBytes(state.sizeBytes)}` : undefined}
      action={state.kind === "saved" ? <ItemMenu label={`Export saved data for ${title}`} testId="artifact-storage-export-menu" entries={[
        { label: "Export SQLite", disabled: busy, onSelect: () => exportFile({ format: "sqlite" }) },
        ...state.collections.map((name) => ({ label: `Export CSV · ${name}`, disabled: busy, onSelect: () => exportFile({ format: "csv", collection: name }) })),
      ]} /> : <span className="text-[12px] text-gray-500">Artifact</span>}
    />
  );
}
