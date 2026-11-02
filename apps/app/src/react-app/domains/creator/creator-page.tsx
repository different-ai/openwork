/** @jsxImportSource react */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blocks,
  FlaskConical,
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
import { toast } from "@/components/ui/sonner";
import type {
  OpenworkServerClient,
} from "@/app/lib/openwork-server";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import {
  deletePreset,
  describePreset,
  listPresets,
  savePreset,
  type CreatorPreset,
} from "@/react-app/domains/creator/presets";

type CreatorPageProps = {
  workspace: RouteWorkspace;
  openworkServerClient: OpenworkServerClient | null;
};

export function CreatorPage({ workspace, openworkServerClient: client }: CreatorPageProps) {
  const queryClient = useQueryClient();
  const workspaceId = workspace.id;
  const [presetName, setPresetName] = useState("");
  const [presets, setPresets] = useState<CreatorPreset[]>(() => listPresets());
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const compositionKey = ["creator-composition", workspaceId];

  const compositionQuery = useQuery({
    queryKey: compositionKey,
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      const [skills, plugins, mcp, commands, reloadEvents] = await Promise.all([
        client.listSkills(workspaceId, { includeGlobal: true }),
        client.listPlugins(workspaceId, { includeGlobal: true }),
        client.listMcp(workspaceId),
        client.listCommands(workspaceId, "workspace"),
        client.listReloadEvents(workspaceId),
      ]);
      return { skills: skills.items, plugins: plugins.items, mcp: mcp.items, commands: commands.items, reloadEvents: reloadEvents.items };
    },
    enabled: Boolean(client && workspaceId),
    refetchInterval: 30_000,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: compositionKey });
  }, [compositionKey, queryClient]);

  const skills = compositionQuery.data?.skills ?? [];
  const plugins = compositionQuery.data?.plugins ?? [];
  const mcpServers = compositionQuery.data?.mcp ?? [];
  const commands = compositionQuery.data?.commands ?? [];
  const reloadEvents = compositionQuery.data?.reloadEvents ?? [];

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
    let applied = 0;
    const failures: string[] = [];
    for (const skill of preset.skills) {
      try {
        await client.upsertSkill(workspaceId, { name: skill.name, content: skill.content, description: skill.description });
        applied += 1;
      } catch {
        failures.push(`skill ${skill.name}`);
      }
    }
    for (const plugin of preset.plugins) {
      try {
        await client.addPlugin(workspaceId, plugin.spec);
        applied += 1;
      } catch {
        failures.push(`plugin ${plugin.spec}`);
      }
    }
    for (const server of preset.mcp) {
      try {
        await client.addMcp(workspaceId, { name: server.name, config: server.config });
        applied += 1;
      } catch {
        failures.push(`MCP ${server.name}`);
      }
    }
    for (const command of preset.commands) {
      try {
        await client.upsertCommand(workspaceId, {
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
    await invalidate();
    if (failures.length > 0) {
      toast.warning(`Preset aplicado con ${applied} escrituras ok y fallos en: ${failures.join(", ")}`);
    } else {
      toast.success(`Preset aplicado: ${describePreset(preset)}. Recarga el motor para activarlo.`);
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
      <div className="flex items-center justify-between gap-4 px-10 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Creador</h1>
        <Button size="sm" variant="outline" onClick={() => void reloadEngine()}>
          <RefreshCw className="size-4" aria-hidden />
          Recargar motor
        </Button>
      </div>
      <p className="px-10 pt-1 text-xs text-muted-foreground">
        ComposiciÃ³n en vivo del motor de {workspace.displayNameResolved}: skills, plugins, conectores y comandos.
        Cambia piezas, observa las recargas y guarda la combinaciÃ³n como preset reutilizable.
      </p>

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

          {presets.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
              AÃºn no hay presets. Ajusta la composiciÃ³n y guÃ¡rdala para lanzar este tipo de entorno de nuevo.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((preset) => (
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
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" className="h-7 flex-1 text-xs" onClick={() => void applyPreset(preset)}>
                      Aplicar aquÃ­
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => exportPreset(preset)}>
                      Exportar
                    </Button>
                  </div>
                </li>
              ))}
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
