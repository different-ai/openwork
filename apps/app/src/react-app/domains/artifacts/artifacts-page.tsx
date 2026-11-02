/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCode2, FileImage, FileText, FileSpreadsheet, File as FileIcon, Folder, RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { cn } from "@/lib/utils";

type CatalogEntry = { path: string; kind: "file" | "dir"; size: number; mtimeMs: number };

const EXCLUDED_PREFIXES = new Set([
  "node_modules/", ".git/", "dist/", ".next/", "coverage/", ".turbo/",
  ".opencode/", ".warden/", "evals/", ".claude/", "tmp/",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".jsonl", ".lock", ".snap", ".map", ".wasm", ".exe", ".dll", ".so",
]);

function fileKind(path: string): "code" | "docs" | "images" | "data" | "other" {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".sh", ".css", ".html"].includes(ext)) return "code";
  if ([".md", ".txt", ".mdx", ".rst"].includes(ext)) return "docs";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "images";
  if ([".json", ".yaml", ".yml", ".toml", ".csv", ".xml"].includes(ext)) return "data";
  return "other";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type FileCategory = "all" | "code" | "docs" | "images" | "data";

const CATEGORIES: Array<{ value: FileCategory; label: string }> = [
  { value: "all", label: "Todo" },
  { value: "code", label: "CÃ³digo" },
  { value: "docs", label: "Docs" },
  { value: "images", label: "ImÃ¡genes" },
  { value: "data", label: "Datos" },
];

function ArtifactCard({ entry, onOpen }: { entry: CatalogEntry; onOpen: () => void }) {
  const kind = fileKind(entry.path);
  const Icon = kind === "code" ? FileCode2 : kind === "docs" ? FileText : kind === "images" ? FileImage : kind === "data" ? FileSpreadsheet : FileIcon;
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col gap-1.5 rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
    >
      <div className="flex items-center gap-2">
        <Icon className={cn(
          "size-4 shrink-0",
          kind === "code" ? "text-blue-11" : kind === "docs" ? "text-green-11" : kind === "images" ? "text-amber-11" : "text-muted-foreground",
        )} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatSize(entry.size)}</span>
      </div>
      <span className="truncate text-xs text-muted-foreground">{dir}</span>
    </button>
  );
}

type ArtefactosPageProps = {
  openworkServerClient: OpenworkServerClient | null;
  workspaceId: string;
};

export function ArtefactosPage({ openworkServerClient: client, workspaceId }: ArtefactosPageProps) {
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<FileCategory>("all");

  const catalogQuery = useQuery({
    queryKey: ["workspace-catalog", workspaceId],
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      return client.listWorkspaceFiles(workspaceId);
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 30_000,
  });

  const entries = useMemo(() => {
    if (!catalogQuery.data) return [];
    return (catalogQuery.data.items ?? [])
      .filter((item) => item.kind === "file")
      .filter((item) => {
        const lower = item.path.toLowerCase();
        return ![...EXCLUDED_PREFIXES].some((prefix) => lower.startsWith(prefix))
          && ![...EXCLUDED_EXTENSIONS].some((ext) => lower.endsWith(ext));
      })
      .map((item) => ({ path: item.path, kind: "file" as const, size: item.size ?? 0, mtimeMs: item.mtimeMs ?? 0 }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }, [catalogQuery.data]);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return entries.filter((entry) => {
      if (category !== "all" && fileKind(entry.path) !== category) return false;
      if (query && !entry.path.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [entries, filter, category]);

  const grouped = useMemo(() => {
    const groups = new Map<string, { dir: string; items: CatalogEntry[] }>();
    for (const entry of filtered) {
      const dir = entry.path.slice(0, entry.path.lastIndexOf("/")) || entry.path;
      const group = groups.get(dir);
      if (group) group.items.push(entry);
      else groups.set(dir, { dir, items: [entry] });
    }
    return [...groups.values()];
  }, [filtered]);

  if (!client) {
    return (
      <Empty variant="ghost" className="h-full">
        <EmptyHeader>
          <EmptyTitle>Servidor no conectado</EmptyTitle>
          <EmptyDescription>Conecta un workspace para ver sus artefactos.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Buscar artefactos"
            aria-label="Buscar artefactos"
            className="h-8 pl-8"
          />
        </div>
        <div className="flex gap-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              type="button"
              onClick={() => setCategory(cat.value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                category === cat.value
                  ? "bg-foreground text-background font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void catalogQuery.refetch()}
          aria-label="Refrescar catÃ¡logo"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {catalogQuery.isPending ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : catalogQuery.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">El catÃ¡logo no se pudo leer.</p>
            <Button variant="outline" size="sm" onClick={() => void catalogQuery.refetch()}>
              <RefreshCw className="size-3.5" aria-hidden />
              Reintentar
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <Empty variant="ghost" className="h-full">
            <EmptyHeader>
              <EmptyTitle>No hay artefactos</EmptyTitle>
              <EmptyDescription>
                Los ficheros que los agentes produzcan en el workspace aparecerÃ¡n aquÃ­.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          grouped.map((group) => (
            <div key={group.dir} className="mb-6">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Folder className="size-3.5" aria-hidden />
                <span className="truncate">{group.dir}</span>
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {group.items.map((item) => (
                  <ArtifactCard key={item.path} entry={item} onOpen={() => { /* open in artifact panel */ }} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
