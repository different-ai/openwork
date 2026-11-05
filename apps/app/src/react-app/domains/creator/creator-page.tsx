/** @jsxImportSource react */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blocks,
  FlaskConical,
  Hammer,
  Plug,
  RefreshCw,
  Save,
  SquareTerminal,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import type {
  OpenworkServerClient,
} from "@/app/lib/openwork-server";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import {
  deletePreset,
  describePreset,
  INTENT_TEMPLATES,
  listPresets,
  savePreset,
  validatePreset,
  type CreatorPreset,
} from "@/react-app/domains/creator/presets";

type CreatorPageProps = {
  workspace: RouteWorkspace;
  openworkServerClient: OpenworkServerClient | null;
  /** Starts an agent session in this workspace with the given build request. */
  onSend: (prompt: string) => void;
  /** Called after a preset launches a brand-new workspace. */
  onWorkspaceLaunched?: (workspaceId: string) => void;
};

/** The DSH-style creator loop in one prompt: the agent (which IS the OpenCode
 * engine) designs, writes, tests and installs the tool into the workspace's
 * `.opencode/` plugin surface. The engine reloads as those files change. */
function buildRequestPrompt(request: string): string {
  return [
    `Actúa como constructor de herramientas de este workspace (modo Creador). Petición del usuario: ${request.trim()}`,
    "",
    "Diseña, escribe, prueba e instala la herramienta directamente, sin pedir permiso para escribir en el workspace:",
    "1. Elige el tipo correcto y dilo en una línea: plugin de OpenCode (`.opencode/plugin/<slug>.js`, usando la API real de plugins del motor), skill (`.opencode/skill/<slug>/SKILL.md` con frontmatter name/description) o agente (`.opencode/agent/<slug>.md`).",
    "2. Escribe el fichero completo y funcional — nada de esqueletos ni pseudocódigo.",
    "3. Pruébalo con el shell cuando sea posible (un smoke test que falle ruidosamente si la herramienta no funciona) y corrige hasta que pase.",
    "4. Termina con un resumen: qué instalaste, dónde, cómo se usa y cómo se desinstala.",
    "",
    "Si la petición es ambigua, elige la interpretación más simple que funcione y documenta las decisiones en el resumen final.",
  ].join("\n");
}

export function CreatorPage({ workspace, openworkServerClient: client, onSend, onWorkspaceLaunched }: CreatorPageProps) {
  const queryClient = useQueryClient();
  const workspaceId = workspace.id;
  const [buildRequest, setBuildRequest] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presets, setPresets] = useState<CreatorPreset[]>(() => listPresets());
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [launchingPresetId, setLaunchingPresetId] = useState<string | null>(null);
  const [launchFolder, setLaunchFolder] = useState("");
  const [launchName, setLaunchName] = useState("");
  const [launchBusy, setLaunchBusy] = useState(false);
  const [showRuntime, setShowRuntime] = useState(false);

  const compositionKey = ["creator-composition", workspaceId];

  const compositionQuery = useQuery({
    queryKey: compositionKey,
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      const [skills, plugins, mcp, commands, reloadEvents, files] = await Promise.all([
        client.listSkills(workspaceId, { includeGlobal: true }),
        client.listPlugins(workspaceId, { includeGlobal: true }),
        client.listMcp(workspaceId),
        client.listCommands(workspaceId, "workspace"),
        client.listReloadEvents(workspaceId),
        client.listWorkspaceFiles(workspaceId),
      ]);
      const toolPrefixes = [".opencode/plugin/", ".opencode/skill/", ".opencode/agent/"];
      const recentToolFiles = (files.items ?? [])
        .filter((file) => file.kind === "file" && toolPrefixes.some((prefix) => file.path.startsWith(prefix)))
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
        .slice(0, 8);
      return { skills: skills.items, plugins: plugins.items, mcp: mcp.items, commands: commands.items, reloadEvents: reloadEvents.items, recentToolFiles };
    },
    enabled: Boolean(client && workspaceId),
    refetchInterval: 15_000,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: compositionKey });
  }, [compositionKey, queryClient]);

  const skills = compositionQuery.data?.skills ?? [];
  const plugins = compositionQuery.data?.plugins ?? [];
  const mcpServers = compositionQuery.data?.mcp ?? [];
  const commands = compositionQuery.data?.commands ?? [];
  const reloadEvents = compositionQuery.data?.reloadEvents ?? [];
  const recentToolFiles = compositionQuery.data?.recentToolFiles ?? [];

  // Deep runtime inspection: what the engine actually runs with, not just what
  // is declared on disk.
  const runtimeQuery = useQuery({
    queryKey: ["creator-runtime", workspaceId],
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      const [runMode, disabledProviders, config] = await Promise.all([
        client.getWorkspaceRunMode(workspaceId),
        client.getRuntimeDisabledProviders(workspaceId),
        client.readOpencodeConfigFile(workspaceId, "project"),
      ]);
      return {
        runMode: runMode.mode,
        catchAll: runMode.catchAll,
        runModeSupported: runMode.supported,
        disabledProviders: disabledProviders.disabledProviders,
        configPath: config.path,
        configExists: config.exists,
        configContent: config.content,
      };
    },
    enabled: Boolean(client && workspaceId && showRuntime),
    staleTime: 15_000,
  });

  const foldersQuery = useQuery({
    queryKey: ["creator-folders", workspaceId],
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      return client.listAuthorizedFolders(workspaceId);
    },
    enabled: Boolean(client && workspaceId && launchingPresetId !== null),
    staleTime: 60_000,
  });

  const applyPresetToWorkspace = useCallback(async (preset: CreatorPreset, targetWorkspaceId: string): Promise<{ applied: number; failures: string[]; skippedMcp: string[] }> => {
    if (!client) return { applied: 0, failures: [], skippedMcp: [] };
    let applied = 0;
    const failures: string[] = [];
    const skippedMcp: string[] = [];
    // Mount order: servers and plugins first, then the skills and commands
    // that may reference them. Unconfigured MCP slots are skipped, never
    // written empty.
    for (const server of preset.mcp) {
      const empty = !server.config || Object.keys(server.config).length === 0;
      if (server.needsConfig || empty) {
        skippedMcp.push(server.name);
        continue;
      }
      try {
        await client.addMcp(targetWorkspaceId, { name: server.name, config: server.config });
        applied += 1;
      } catch {
        failures.push(`MCP ${server.name}`);
      }
    }
    for (const plugin of preset.plugins) {
      try {
        await client.addPlugin(targetWorkspaceId, plugin.spec);
        applied += 1;
      } catch {
        failures.push(`plugin ${plugin.spec}`);
      }
    }
    for (const skill of preset.skills) {
      if (!skill.content.trim()) {
        failures.push(`skill ${skill.name} (vacía)`);
        continue;
      }
      try {
        await client.upsertSkill(targetWorkspaceId, { name: skill.name, content: skill.content, description: skill.description });
        applied += 1;
      } catch {
        failures.push(`skill ${skill.name}`);
      }
    }
    for (const command of preset.commands) {
      if (!command.template.trim()) {
        failures.push(`comando /${command.name} (vacío)`);
        continue;
      }
      try {
        await client.upsertCommand(targetWorkspaceId, {
          name: command.name,
          template: command.template,
          description: command.description,
          agent: command.agent,
          model: command.model ?? null,
          subtask: command.subtask,
        });
        applied += 1;
      } catch {
        failures.push(`comando /${command.name}`);
      }
    }
    return { applied, failures, skippedMcp };
  }, [client]);

  const launchPreset = async (preset: CreatorPreset) => {
    if (!client || !launchFolder.trim()) return;
    setLaunchBusy(true);
    try {
      const folder = launchFolder.trim();
      const list = await client.createLocalWorkspace({
        folderPath: folder,
        name: (launchName.trim() || preset.name || folder.split(/[\\/]/).pop() || "preset").slice(0, 80),
        preset: "starter",
      });
      const created = list.workspaces.find((item) => item.path === folder) ?? list.workspaces.at(-1);
      if (!created) throw new Error("El workspace creado no apareció en la lista.");
      await client.activateWorkspace(created.id, { persist: true });
      const { applied, failures, skippedMcp } = await applyPresetToWorkspace(preset, created.id);
      await client.reloadEngine(created.id).catch(() => undefined);
      const skippedNote = skippedMcp.length > 0 ? ` MCP omitidos sin configurar: ${skippedMcp.join(", ")}.` : "";
      toast.success(
        `Entorno lanzado con el preset "${preset.name}" (${applied} escrituras${failures.length > 0 ? `, fallos: ${failures.join(", ")}` : ""}).${skippedNote}`,
      );
      setLaunchingPresetId(null);
      setLaunchFolder("");
      setLaunchName("");
      onWorkspaceLaunched?.(created.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo lanzar el entorno.");
    } finally {
      setLaunchBusy(false);
    }
  };

  const startBuild = () => {
    const request = buildRequest.trim();
    if (!request) return;
    onSend(buildRequestPrompt(request));
    setBuildRequest("");
    toast.success("El agente está construyendo la herramienta. Sigue la sesión para verla en vivo.");
  };

  const reloadEngine = async () => {
    if (!client) return;
    try {
      await client.reloadEngine(workspaceId);
      toast.success("Motor recargado");
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo recargar el motor.");
    }
  };

  const applySkillDelete = async (name: string) => {
    if (!client) return;
    try {
      await client.deleteSkill(workspaceId, name);
      toast.success(`Skill ${name} eliminada`);
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo eliminar la skill.");
    }
  };

  const applyPluginRemove = async (name: string) => {
    if (!client) return;
    try {
      await client.removePlugin(workspaceId, name);
      toast.success(`Plugin ${name} eliminado`);
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo eliminar el plugin.");
    }
  };

  const applyMcpToggle = async (name: string, enabled: boolean) => {
    if (!client) return;
    try {
      await client.setMcpEnabled(workspaceId, name, enabled);
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo cambiar el conector.");
    }
  };

  const applyCommandDelete = async (name: string) => {
    if (!client) return;
    try {
      await client.deleteCommand(workspaceId, name);
      toast.success(`Comando /${name} eliminado`);
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo eliminar el comando.");
    }
  };

  const capturePreset = async (): Promise<CreatorPreset | null> => {
    if (!client) return null;
    const skillContents: CreatorPreset["skills"] = [];
    for (const skill of skills) {
      try {
        const full = await client.getSkill(workspaceId, skill.name, { includeGlobal: true });
        skillContents.push({ name: skill.name, content: full.content, description: skill.description || undefined });
      } catch {
        // A skill that no longer resolves is skipped rather than saved broken.
      }
    }
    return {
      id: crypto.randomUUID(),
      name: presetName.trim() || `ComposiciÃ³n ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      workspaceId,
      skills: skillContents,
      plugins: plugins.map((plugin) => ({ spec: plugin.spec })),
      mcp: mcpServers.map((server) => ({ name: server.name, config: server.config })),
      commands: commands.map((command) => ({
        name: command.name,
        template: command.template,
        description: command.description,
        agent: command.agent,
        model: command.model ?? null,
        subtask: command.subtask,
      })),
    };
  };

  const saveCurrentPreset = async () => {
    const preset = await capturePreset();
    if (!preset) return;
    setPresets(savePreset(preset));
    setPresetName("");
    toast.success(`Preset guardado: ${describePreset(preset)} â€” la configuraciÃ³n de MCP puede incluir credenciales; revÃ­sala antes de compartirlo.`);
  };

  const applyPreset = async (preset: CreatorPreset) => {
    if (!client) return;
    const { applied, failures, skippedMcp } = await applyPresetToWorkspace(preset, workspaceId);
    await invalidate();
    const skippedNote = skippedMcp.length > 0 ? ` MCP omitidos sin configurar: ${skippedMcp.join(", ")}.` : "";
    if (failures.length > 0) {
      toast.warning(`Preset aplicado con ${applied} escrituras ok y fallos en: ${failures.join(", ")}.${skippedNote}`);
    } else {
      toast.success(`Preset aplicado: ${describePreset(preset)}.${skippedNote} Recarga el motor para activarlo.`);
    }
  };

  const exportPreset = (preset: CreatorPreset) => {
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${preset.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "preset"}.openwork-preset.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importPreset = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as CreatorPreset;
      if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string" || !Array.isArray(parsed.skills)) {
        throw new Error("Formato no reconocido");
      }
      const normalized: CreatorPreset = { ...parsed, id: crypto.randomUUID(), createdAt: Date.now(), workspaceId };
      setPresets(savePreset(normalized));
      toast.success(`Preset importado: ${normalized.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo importar el preset.");
    }
  };

  if (!client) {
    return (
      <Empty variant="ghost" className="h-full">
        <EmptyHeader>
          <EmptyTitle>Servidor no conectado</EmptyTitle>
          <EmptyDescription>Conecta un workspace para inspeccionar su composiciÃ³n.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between gap-4 px-10 pt-6">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Creador</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowRuntime((value) => !value)}>
            Runtime
          </Button>
          <Button size="sm" variant="outline" onClick={() => void reloadEngine()}>
            <RefreshCw className="size-4" aria-hidden />
            Recargar motor
          </Button>
        </div>
      </div>
      <p className="px-10 pt-1 text-xs text-muted-foreground">
        Describe una herramienta en lenguaje natural y el agente la diseña, escribe, prueba e instala en este workspace.
        O compón a mano: inspecciona, cambia piezas y guarda presets.
      </p>

      <div className="px-10 pt-4">
        <div className="rounded-2xl border border-border bg-muted/40 p-4">
          <Textarea
            value={buildRequest}
            onChange={(event) => setBuildRequest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                startBuild();
              }
            }}
            placeholder="Ej.: un plugin que vigile los contenedores docker caídos y escriba un informe en context/informes/… o una skill que revise PRs con el estándar del equipo…"
            aria-label="Describe la herramienta a construir"
            className="min-h-16 resize-none border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground">El agente escribirá en .opencode/ y el motor se recargará solo.</span>
            <Button size="sm" disabled={!buildRequest.trim()} onClick={startBuild}>
              <Hammer className="size-4" aria-hidden />
              Construir
            </Button>
          </div>
        </div>
      </div>

      {showRuntime ? (
        <div className="mx-10 mt-4 rounded-xl border border-border p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Runtime del motor — lo que realmente ejecuta</p>
          {runtimeQuery.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : runtimeQuery.isError ? (
            <p className="text-xs text-muted-foreground">El runtime no se pudo leer.</p>
          ) : (
            <div className="flex flex-col gap-1 text-xs">
              <p>
                <span className="text-muted-foreground">Modo de permisos:</span>{" "}
                {runtimeQuery.data?.runModeSupported
                  ? `${runtimeQuery.data?.runMode ?? "—"} (catch-all: ${runtimeQuery.data?.catchAll ?? "—"})`
                  : "no soportado por este runtime"}
              </p>
              <p>
                <span className="text-muted-foreground">Proveedores deshabilitados:</span>{" "}
                {(runtimeQuery.data?.disabledProviders ?? []).length > 0
                  ? (runtimeQuery.data?.disabledProviders ?? []).join(", ")
                  : "ninguno"}
              </p>
              <p>
                <span className="text-muted-foreground">Config del motor:</span>{" "}
                <code className="rounded bg-muted px-1">{runtimeQuery.data?.configPath}</code>
                {runtimeQuery.data?.configExists ? "" : " (sin crear aún)"}
              </p>
              {runtimeQuery.data?.configContent ? (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] text-foreground">
                  {runtimeQuery.data?.configContent}
                </pre>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <div className="flex flex-1 gap-8 px-10 pt-6 pb-10">
        {/* Composition column */}
        <div className="min-w-0 flex-1">
          <CompositionSection
            icon={Wrench}
            title="Skills"
            count={skills.length}
            pending={compositionQuery.isPending}
            emptyLabel="Sin skills. Se aÃ±aden desde PersonalizaciÃ³n o como ficheros .opencode/skill."
          >
            {skills.map((skill) => (
              <li key={`${skill.scope}/${skill.name}`} className="flex items-center gap-2 border-b border-border/60 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{skill.name}</p>
                  {skill.description ? (
                    <p className="truncate text-xs text-muted-foreground">{skill.description}</p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">{skill.scope === "global" ? "global" : "proyecto"}</span>
                {skill.scope === "project" ? (
                  <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-red-600" aria-label={`Eliminar ${skill.name}`} onClick={() => void applySkillDelete(skill.name)}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </CompositionSection>

          <CompositionSection
            icon={Blocks}
            title="Plugins"
            count={plugins.length}
            pending={compositionQuery.isPending}
            emptyLabel="Sin plugins."
          >
            {plugins.map((plugin) => (
              <li key={plugin.spec} className="flex items-center gap-2 border-b border-border/60 py-2">
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">{plugin.spec}</p>
                <span className="shrink-0 text-[10px] text-muted-foreground">{plugin.source}</span>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-red-600" aria-label={`Eliminar ${plugin.spec}`} onClick={() => void applyPluginRemove(plugin.spec)}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </CompositionSection>

          <CompositionSection
            icon={Plug}
            title="Conectores MCP"
            count={mcpServers.length}
            pending={compositionQuery.isPending}
            emptyLabel="Sin conectores MCP."
          >
            {mcpServers.map((server) => (
              <li key={server.name} className="flex items-center gap-2 border-b border-border/60 py-2">
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">{server.name}</p>
                <span className="shrink-0 text-[10px] text-muted-foreground">{server.source}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => void applyMcpToggle(server.name, Boolean(server.disabledByTools))}
                >
                  {server.disabledByTools ? "Habilitar" : "Deshabilitar"}
                </Button>
              </li>
            ))}
          </CompositionSection>

          <CompositionSection
            icon={SquareTerminal}
            title="Comandos"
            count={commands.length}
            pending={compositionQuery.isPending}
            emptyLabel="Sin comandos de workspace."
          >
            {commands.map((command) => (
              <li key={command.name} className="flex items-center gap-2 border-b border-border/60 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">/{command.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{command.template}</p>
                </div>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-red-600" aria-label={`Eliminar /${command.name}`} onClick={() => void applyCommandDelete(command.name)}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </CompositionSection>

          {recentToolFiles.length > 0 ? (
            <div className="mt-6">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Construcciones recientes del agente (.opencode/)</p>
              <ul className="flex flex-col gap-1">
                {recentToolFiles.map((file) => (
                  <li key={file.path} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">{file.path}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {file.mtimeMs ? new Date(file.mtimeMs).toLocaleString() : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {reloadEvents.length > 0 ? (
            <div className="mt-6">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Recargas recientes del motor</p>
              <ul className="flex flex-col gap-1">
                {reloadEvents.slice(0, 5).map((event) => (
                  <li key={event.id} className="text-xs text-muted-foreground">
                    {new Date(event.timestamp).toLocaleTimeString()} â€” {event.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* Presets rail */}
        <div className="w-80 shrink-0">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <FlaskConical className="size-3.5" aria-hidden />
            Presets
          </p>
          <div className="mb-3 flex gap-2">
            <Input
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder="Nombre del preset"
              aria-label="Nombre del preset"
              className="h-8 flex-1"
            />
            <Button size="sm" onClick={() => void saveCurrentPreset()} disabled={compositionQuery.isPending}>
              <Save className="size-4" aria-hidden />
              Guardar
            </Button>
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              void importPreset(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <Button variant="outline" size="sm" className="mb-3 w-full" onClick={() => importInputRef.current?.click()}>
            <Upload className="size-4" aria-hidden />
            Importar preset (.json)
          </Button>

          <details className="mb-3 rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Plantillas por intención
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {INTENT_TEMPLATES.map((template) => (
                <li key={template.id} className="rounded-lg border border-border/60 p-2">
                  <p className="text-xs font-medium text-foreground">{template.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{template.description}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1.5 h-6 w-full text-[11px]"
                    onClick={() => {
                      const draft = template.build();
                      setPresets(savePreset(draft));
                      toast.success(`Plantilla añadida como borrador: ${draft.name}. Configura sus MCP antes de aplicarla.`);
                    }}
                  >
                    Usar plantilla
                  </Button>
                </li>
              ))}
            </ul>
          </details>

          {presets.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              AÃºn no hay presets. Ajusta la composiciÃ³n y guÃ¡rdala para lanzar este tipo de entorno de nuevo.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((preset) => {
                const validation = validatePreset(preset);
                return (
                <li key={preset.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{preset.name}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-red-600"
                      aria-label={`Eliminar preset ${preset.name}`}
                      onClick={() => setPresets(deletePreset(preset.id))}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{describePreset(preset)}</p>
                  {validation.unconfiguredMcp.length > 0 ? (
                    <p className="mt-1 text-[11px] text-amber-600">
                      Sin configurar (se omitirán al aplicar): {validation.unconfiguredMcp.join(", ")}
                    </p>
                  ) : null}
                  {validation.problems.length > 0 ? (
                    <p className="mt-1 text-[11px] text-red-600">Problemas: {validation.problems.join("; ")}</p>
                  ) : null}
                  {preset.mcp.filter((server) => server.needsConfig || !server.config || Object.keys(server.config).length === 0).length > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">Configurar MCP</summary>
                      {preset.mcp.filter((server) => server.needsConfig || !server.config || Object.keys(server.config).length === 0).map((server) => (
                        <McpConfigEditor
                          key={server.name}
                          name={server.name}
                          initialConfig={server.config}
                          onSave={(config) => {
                            setPresets(savePreset({
                              ...preset,
                              mcp: preset.mcp.map((entry) => entry.name === server.name
                                ? { ...entry, config, needsConfig: false }
                                : entry),
                            }));
                            toast.success(`Configuración de ${server.name} guardada.`);
                          }}
                        />
                      ))}
                    </details>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" className="h-7 flex-1 text-xs" onClick={() => void applyPreset(preset)}>
                      Aplicar aquí
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setLaunchingPresetId((current) => (current === preset.id ? null : preset.id));
                        setLaunchName(preset.name);
                        setLaunchFolder("");
                      }}
                    >
                      Lanzar en nuevo
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => exportPreset(preset)}>
                      Exportar
                    </Button>
                  </div>
                  {launchingPresetId === preset.id ? (
                    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-2">
                      {foldersQuery.isPending ? (
                        <Skeleton className="h-7 w-full" />
                      ) : (foldersQuery.data?.folders ?? []).length === 0 ? (
                        <p className="text-xs text-muted-foreground">No hay carpetas autorizadas para crear el workspace.</p>
                      ) : (
                        <select
                          value={launchFolder}
                          onChange={(event) => setLaunchFolder(event.target.value)}
                          aria-label="Carpeta para el nuevo workspace"
                          className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        >
                          <option value="">Carpeta…</option>
                          {(foldersQuery.data?.folders ?? []).map((folder) => (
                            <option key={folder} value={folder}>{folder}</option>
                          ))}
                        </select>
                      )}
                      <Input
                        value={launchName}
                        onChange={(event) => setLaunchName(event.target.value)}
                        placeholder="Nombre del proyecto"
                        aria-label="Nombre del proyecto"
                        className="h-7 text-xs"
                      />
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={launchBusy || !launchFolder.trim()}
                        onClick={() => void launchPreset(preset)}
                      >
                        {launchBusy ? "Lanzando…" : "Crear workspace y aplicar preset"}
                      </Button>
                    </div>
                  ) : null}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CompositionSection({ icon: Icon, title, count, pending, emptyLabel, children }: {
  icon: typeof Wrench;
  title: string;
  count: number;
  pending: boolean;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-6">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {title}
        <span className="text-[10px] font-normal">({count})</span>
      </p>
      {pending ? (
        <div className="flex flex-col gap-2 pt-1">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : count === 0 ? (
        <p className="pt-1 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul>{children}</ul>
      )}
    </div>
  );
}

/** Inline JSON editor for an unconfigured MCP slot of a preset draft. */
function McpConfigEditor({ name, initialConfig, onSave }: {
  name: string;
  initialConfig: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(initialConfig, null, 2));
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Se esperaba un objeto JSON");
      setError(null);
      onSave(parsed as Record<string, unknown>);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "JSON no válido");
    }
  };

  return (
    <div className="mt-2 rounded-md border border-border/60 p-2">
      <p className="mb-1 text-[11px] text-muted-foreground">
        Config JSON de <span className="font-medium text-foreground">{name}</span> (puede incluir credenciales)
      </p>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-20 resize-y bg-background font-mono text-[11px]"
        aria-label={`Configuración JSON del conector ${name}`}
      />
      {error ? <p className="mt-1 text-[11px] text-red-600">{error}</p> : null}
      <Button size="sm" className="mt-1.5 h-6 w-full text-[11px]" onClick={save}>
        Guardar configuración
      </Button>
    </div>
  );
}
