/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, ImagePlus, Layers, Link2, Search, Sparkles, Trash2 } from "lucide-react";

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
import { toast } from "@/components/ui/sonner";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import type { ProviderCatalog } from "@/react-app/domains/session/surface/use-model-behavior";
import {
  TaskSelectionSelects,
  useTaskSelection,
  type TaskSelection,
} from "@/react-app/domains/projects/task-selection";
import { cn } from "@/lib/utils";

const REFERENCES_DIR = "context/design/referencias/";
const DESIGN_SYSTEMS_DIR = "context/design/design-systems/";
const ACTIVE_DESIGN_MD = "context/design/DESIGN.md";
const OPEN_DESIGN_REPO = "nexu-io/open-design";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

type DesignTab = "references" | "catalogs" | "systems";

const TABS: Array<{ id: DesignTab; label: string }> = [
  { id: "references", label: "Referencias" },
  { id: "catalogs", label: "Catálogos" },
  { id: "systems", label: "Sistemas de diseño" },
];

const ASPECTS = [
  { id: "layout", label: "Layout" },
  { id: "palette", label: "Paleta" },
  { id: "typography", label: "Tipografía" },
  { id: "components", label: "Componentes" },
  { id: "motion", label: "Movimiento" },
  { id: "voice", label: "Tono/copy" },
] as const;

type AspectId = (typeof ASPECTS)[number]["id"];

type DesignPageProps = {
  workspace: RouteWorkspace;
  openworkServerClient: OpenworkServerClient | null;
  agents: string[];
  providerCatalog: ProviderCatalog;
  connectedProviderIds: string[];
  onSend: (prompt: string, selection: TaskSelection) => void;
};

export function DesignPage({
  workspace,
  openworkServerClient: client,
  agents,
  providerCatalog,
  connectedProviderIds,
  onSend,
}: DesignPageProps) {
  const queryClient = useQueryClient();
  const selection = useTaskSelection(providerCatalog, connectedProviderIds);
  const [tab, setTab] = useState<DesignTab>("references");
  const [aspectState, setAspectState] = useState<Record<AspectId, boolean>>({
    layout: true, palette: true, typography: true, components: true, motion: false, voice: false,
  });
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [captureUrl, setCaptureUrl] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);

  const workspaceId = workspace.id;

  const designQuery = useQuery({
    queryKey: ["design-references", workspaceId],
    queryFn: async () => {
      if (!client || !workspaceId) return { references: [], installedSystems: [], hasActiveSystem: false };
      const result = await client.listWorkspaceFiles(workspaceId);
      const items = result.items ?? [];
      return {
        references: items
          .filter((file) => file.kind === "file" && file.path.startsWith(REFERENCES_DIR) && isImagePath(file.path))
          .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)),
        installedSystems: items
          .filter((file) => file.kind === "file" && file.path.startsWith(DESIGN_SYSTEMS_DIR) && file.path.endsWith(".md"))
          .map((file) => file.path.slice(DESIGN_SYSTEMS_DIR.length, -".md".length)),
        hasActiveSystem: items.some((file) => file.kind === "file" && file.path === ACTIVE_DESIGN_MD),
      };
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 30_000,
  });

  const references = designQuery.data?.references ?? [];
  const installedSystems = designQuery.data?.installedSystems ?? [];
  const hasActiveSystem = designQuery.data?.hasActiveSystem ?? false;

  const invalidateDesign = () => queryClient.invalidateQueries({ queryKey: ["design-references", workspaceId] });

  const capture = async (url: string, onDone?: () => void) => {
    if (!client || !workspaceId || !url.trim()) return;
    setCapturing(true);
    try {
      const result = await client.captureDesignReference(workspaceId, url.trim());
      toast.success(`Referencia capturada: ${result.items[0]?.path ?? "ok"}`);
      setCaptureUrl("");
      await invalidateDesign();
      onDone?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo capturar la referencia.");
    } finally {
      setCapturing(false);
    }
  };

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!client || !workspaceId || !files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const dot = file.name.lastIndexOf(".");
        const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
        const safeStem = (dot >= 0 ? file.name.slice(0, dot) : file.name)
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, "-")
          .replace(/^-+|-+$/g, "") || "referencia";
        const path = `${REFERENCES_DIR}${Date.now()}-${safeStem}${extension || ".png"}`;
        await client.writeWorkspaceBinaryFile(workspaceId, { path, data: await file.arrayBuffer() });
      }
      toast.success("Referencias añadidas al proyecto");
      await invalidateDesign();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudieron subir las referencias.");
    } finally {
      setUploading(false);
    }
  };

  const remove = async (path: string) => {
    if (!client || !workspaceId) return;
    try {
      const dot = path.lastIndexOf(".");
      const sidecar = (dot >= 0 ? path.slice(0, dot) : path) + ".json";
      await client.deleteWorkspaceFiles(workspaceId, [{ path }, { path: sidecar }]).catch(() => undefined);
      setSelectedPaths((current) => current.filter((item) => item !== path));
      await invalidateDesign();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo borrar la referencia.");
    }
  };

  const activeAspects = () => ASPECTS.filter((aspect) => aspectState[aspect.id]).map((aspect) => aspect.label);

  const startDesignTask = (prompt: string) => {
    onSend(prompt, {
      model: selection.selectedModel,
      variant: selection.selectedModel ? selection.variant : null,
      agent: selection.agent,
    });
  };

  const clonePrompt = (paths: string[]) => {
    const aspects = activeAspects();
    const targetList = paths.length === 1 ? `la referencia \`${paths[0]!}\`` : `las referencias ${paths.map((path) => `\`${path}\``).join(", ")}`;
    return [
      `Clona el estilo visual de ${targetList} de este proyecto.`,
      aspects.length > 0 ? `Extrae y aplica únicamente: ${aspects.join(", ")}.` : "",
      hasActiveSystem
        ? `El proyecto además tiene un sistema de diseño activo en \`${ACTIVE_DESIGN_MD}\`: sigue sus tokens y reglas; donde la referencia y el sistema contradigan, manda el sistema.`
        : "",
      "Genera una página de ejemplo aplicando el estilo con fidelidad y entrégala como artefacto, acompañada de un resumen del estilo extraído.",
    ].filter(Boolean).join(" ");
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between gap-4 px-10 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Design</h1>
        <div className="flex items-center gap-2">
          <TaskSelectionSelects
            modelGroups={selection.modelGroups}
            selectedModel={selection.selectedModel}
            selectModel={selection.selectModel}
            variant={selection.variant}
            setVariant={selection.setVariant}
            variantOptions={selection.variantOptions}
            agent={selection.agent}
            setAgent={selection.setAgent}
            agents={agents}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 px-10 pt-4">
        <div className="flex gap-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                tab === entry.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {hasActiveSystem ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 text-green-600" aria-hidden />
            Sistema activo en <code className="rounded bg-muted px-1">{ACTIVE_DESIGN_MD}</code>
          </span>
        ) : null}
      </div>

      <div className="px-10 pt-5 pb-10">
        {tab === "references" ? (
          <ReferencesTab
            client={client}
            workspaceId={workspaceId}
            references={references}
            captureUrl={captureUrl}
            setCaptureUrl={setCaptureUrl}
            capturing={capturing}
            onCapture={() => void capture(captureUrl)}
            uploading={uploading}
            onUploadClick={() => uploadInputRef.current?.click()}
            onUpload={(files) => void upload(files)}
            selectedPaths={selectedPaths}
            setSelectedPaths={setSelectedPaths}
            aspectState={aspectState}
            setAspectState={setAspectState}
            onCloneSelection={() => startDesignTask(clonePrompt(selectedPaths))}
            onCloneOne={(path) => startDesignTask(clonePrompt([path]))}
            onRemove={(path) => void remove(path)}
            uploadInputRef={uploadInputRef}
            capturePending={designQuery.isPending}
          />
        ) : tab === "catalogs" ? (
          <CatalogsTab
            client={client}
            capturing={capturing}
            onCapture={(url) => void capture(url, () => setTab("references"))}
          />
        ) : (
          <SystemsTab
            client={client}
            workspaceId={workspaceId}
            installedSystems={installedSystems}
            installingSlug={installingSlug}
            onInstalled={() => void invalidateDesign()}
            onInstalling={setInstallingSlug}
          />
        )}
      </div>
    </div>
  );
}

function ReferencesTab({
  client, workspaceId, references, captureUrl, setCaptureUrl, capturing, onCapture, uploading, onUploadClick, onUpload,
  selectedPaths, setSelectedPaths, aspectState, setAspectState, onCloneSelection, onCloneOne, onRemove, uploadInputRef, capturePending,
}: {
  client: OpenworkServerClient | null;
  workspaceId: string;
  references: Array<{ path: string }>;
  captureUrl: string;
  setCaptureUrl: (value: string) => void;
  capturing: boolean;
  onCapture: () => void;
  uploading: boolean;
  onUploadClick: () => void;
  onUpload: (files: FileList | null) => void;
  selectedPaths: string[];
  setSelectedPaths: (update: (current: string[]) => string[]) => void;
  aspectState: Record<AspectId, boolean>;
  setAspectState: (update: Record<AspectId, boolean>) => void;
  onCloneSelection: () => void;
  onCloneOne: (path: string) => void;
  onRemove: (path: string) => void;
  uploadInputRef: RefObject<HTMLInputElement | null>;
  capturePending: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Link2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={captureUrl}
            onChange={(event) => setCaptureUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCapture();
            }}
            placeholder="Pega una URL (Refero, Designeer o cualquier web) y captura su imagen"
            aria-label="Capturar referencia por URL"
            className="h-8 pl-8"
          />
        </div>
        <Button size="sm" disabled={!client || capturing || !captureUrl.trim()} onClick={onCapture}>
          {capturing ? "Capturando…" : "Capturar"}
        </Button>
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            onUpload(event.target.files);
            event.target.value = "";
          }}
        />
        <Button size="sm" variant="outline" disabled={uploading || !client} onClick={onUploadClick}>
          <ImagePlus className="size-4" aria-hidden />
          {uploading ? "Subiendo…" : "Subir"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Extraer:</span>
        {ASPECTS.map((aspect) => (
          <button
            key={aspect.id}
            type="button"
            onClick={() => setAspectState({ ...aspectState, [aspect.id]: !aspectState[aspect.id] })}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs",
              aspectState[aspect.id]
                ? "border-foreground/30 bg-muted text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={aspectState[aspect.id]}
          >
            {aspect.label}
          </button>
        ))}
        {selectedPaths.length > 0 ? (
          <Button size="sm" className="ml-auto" onClick={onCloneSelection}>
            Clonar selección ({selectedPaths.length})
          </Button>
        ) : null}
      </div>

      {capturePending ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : references.length === 0 ? (
        <Empty variant="ghost" className="rounded-xl border border-dashed border-border">
          <EmptyHeader>
            <EmptyMedia>
              <Sparkles className="size-6 text-muted-foreground" aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Sin referencias todavía</EmptyTitle>
            <EmptyDescription>
              Captura por URL desde los catálogos o sube pantallazos. Cada referencia vive en el proyecto
              y el agente la lee para clonar su estilo.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {references.map((reference) => (
            <ReferenceCard
              key={reference.path}
              client={client}
              workspaceId={workspaceId}
              path={reference.path}
              selected={selectedPaths.includes(reference.path)}
              onToggle={() => setSelectedPaths((current) => current.includes(reference.path)
                ? current.filter((item) => item !== reference.path)
                : [...current, reference.path])}
              onClone={() => onCloneOne(reference.path)}
              onDelete={() => onRemove(reference.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReferenceCard({ client, workspaceId, path, selected, onToggle, onClone, onDelete }: {
  client: OpenworkServerClient | null;
  workspaceId: string;
  path: string;
  selected: boolean;
  onToggle: () => void;
  onClone: () => void;
  onDelete: () => void;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const previewQuery = useQuery({
    queryKey: ["design-reference-preview", workspaceId, path],
    queryFn: async () => {
      if (!client) return null;
      const result = await client.downloadWorkspaceFile(workspaceId, path);
      const dot = path.lastIndexOf(".");
      const mime = MIME_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? result.contentType ?? "application/octet-stream";
      return URL.createObjectURL(new Blob([result.data], { type: mime }));
    },
    enabled: Boolean(client && workspaceId),
    staleTime: Infinity,
  });

  useEffect(() => {
    const url = previewQuery.data;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [previewQuery.data]);

  return (
    <div className={cn(
      "group relative overflow-hidden rounded-xl border bg-background",
      selected ? "border-foreground/50 ring-1 ring-foreground/30" : "border-border",
    )}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={selected ? "Quitar de la selección" : "Añadir a la selección"}
        className={cn(
          "absolute top-2 left-2 z-10 flex size-5 items-center justify-center rounded-full border transition-opacity",
          selected
            ? "border-foreground bg-foreground text-background opacity-100"
            : "border-border bg-background/90 text-transparent opacity-0 group-hover:opacity-100",
        )}
      >
        <Check className="size-3" aria-hidden />
      </button>
      <div className="flex h-32 items-center justify-center overflow-hidden bg-muted/40">
        {previewQuery.isPending ? (
          <Skeleton className="h-full w-full" />
        ) : previewQuery.data ? (
          <img src={previewQuery.data} alt={name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span className="text-xs text-muted-foreground">Sin vista previa</span>
        )}
      </div>
      <div className="flex items-center gap-1 px-2.5 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={path}>{name}</span>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" onClick={onClone} disabled={!client}>
          Clonar
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-red-600"
          aria-label={`Borrar ${name}`}
          onClick={onDelete}
          disabled={!client}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function CatalogsTab({ client, capturing, onCapture }: {
  client: OpenworkServerClient | null;
  capturing: boolean;
  onCapture: (url: string) => void;
}) {
  const catalogQuery = useInfiniteQuery({
    queryKey: ["designeer-catalog"],
    queryFn: ({ pageParam }) => {
      if (!client) throw new Error("not connected");
      return client.fetchDesigneerCatalog(pageParam ?? undefined);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(client),
    staleTime: 5 * 60_000,
  });

  const items = catalogQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Catálogos curados para encontrar referencias. Elige una, captúrala y aparecerá en tus referencias.
        Refero no expone su catálogo a lectores automáticos: ábrelo en el navegador y pega aquí la URL de la pantalla.
      </p>
      <div className="flex items-center gap-2">
        <a
          href="https://refero.design/"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted/60"
        >
          Abrir Refero
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <a
          href="https://designeer.xyz/"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted/60"
        >
          Abrir Designeer
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <a
          href="https://opendesigner.io/design-systems"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted/60"
        >
          Open Design
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Layers className="size-4" aria-hidden />
          Designeer — finds recientes
        </p>
        {catalogQuery.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : catalogQuery.isError ? (
          <p className="text-sm text-muted-foreground">El catálogo de Designeer no está disponible ahora mismo.</p>
        ) : (
          <>
            <ul className="flex flex-col">
              {items.map((item) => (
                <li key={item.url} className="flex items-center gap-3 border-b border-border/60 py-2.5">
                  <div className="min-w-0 flex-1">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-sm text-foreground hover:underline"
                    >
                      {item.title}
                    </a>
                    {item.description ? (
                      <p className="truncate text-xs text-muted-foreground">{item.description}</p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 text-xs"
                    disabled={!client || capturing}
                    onClick={() => onCapture(item.url)}
                  >
                    {capturing ? "Capturando…" : "Capturar"}
                  </Button>
                </li>
              ))}
            </ul>
            {catalogQuery.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={catalogQuery.isFetchingNextPage}
                onClick={() => void catalogQuery.fetchNextPage()}
              >
                {catalogQuery.isFetchingNextPage ? "Cargando…" : "Más"}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SystemsTab({ client, workspaceId, installedSystems, installingSlug, onInstalled, onInstalling }: {
  client: OpenworkServerClient | null;
  workspaceId: string;
  installedSystems: string[];
  installingSlug: string | null;
  onInstalled: () => void;
  onInstalling: (slug: string | null) => void;
}) {
  const [filter, setFilter] = useState("");
  const catalogQuery = useQuery({
    queryKey: ["open-design-systems"],
    queryFn: async () => {
      const response = await fetch(`https://api.github.com/repos/${OPEN_DESIGN_REPO}/contents/design-systems`);
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      const entries = (await response.json()) as Array<{ name: string; type: string }>;
      return entries.filter((entry) => entry.type === "dir" && !entry.name.startsWith("_")).map((entry) => entry.name);
    },
    staleTime: 10 * 60_000,
    enabled: Boolean(client),
  });

  const systems = catalogQuery.data ?? [];
  const query = filter.trim().toLowerCase();
  const visible = query ? systems.filter((slug) => slug.includes(query)) : systems;

  const install = async (slug: string) => {
    if (!client || !workspaceId) return;
    onInstalling(slug);
    try {
      const response = await fetch(`https://raw.githubusercontent.com/${OPEN_DESIGN_REPO}/main/design-systems/${encodeURIComponent(slug)}/DESIGN.md`);
      if (!response.ok) throw new Error(`DESIGN.md ${response.status}`);
      const content = await response.text();
      await client.writeWorkspaceFile(workspaceId, { path: `${DESIGN_SYSTEMS_DIR}${slug}.md`, content });
      await client.writeWorkspaceFile(workspaceId, {
        path: ACTIVE_DESIGN_MD,
        content: `${content}\n\n<!-- Sistema activo: ${slug} · Apache-2.0 · github.com/${OPEN_DESIGN_REPO} -->\n`,
      });
      toast.success(`Sistema activo: ${slug}`);
      onInstalled();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo instalar el sistema.");
    } finally {
      onInstalling(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Sistemas de diseño del proyecto open-source Open Design (Apache-2.0): {systems.length} sistemas en formato
        DESIGN.md (color, tipografía, espaciado, componentes, movimiento, tono, marca, anti-patrones). Al instalar
        uno queda como <code className="rounded bg-muted px-1">{ACTIVE_DESIGN_MD}</code> y el agente lo sigue en cada tarea de diseño.
      </p>
      <div className="relative max-w-72">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Buscar sistema (linear, stripe…)"
          aria-label="Buscar sistemas de diseño"
          className="h-8 pl-8"
        />
      </div>
      {catalogQuery.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : catalogQuery.isError ? (
        <p className="text-sm text-muted-foreground">El catálogo de Open Design no está disponible ahora mismo.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((slug) => {
            const installed = installedSystems.includes(slug);
            return (
              <li key={slug} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{slug}</span>
                {installed ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">instalado</span>
                ) : null}
                <Button
                  variant={installed ? "outline" : "default"}
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  disabled={!client || installingSlug !== null}
                  onClick={() => void install(slug)}
                >
                  {installingSlug === slug ? "Instalando…" : installed ? "Activar" : "Instalar"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
