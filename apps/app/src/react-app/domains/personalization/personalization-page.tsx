/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { Blocks, Plug, Wrench } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  OpenworkMcpItem,
  OpenworkPluginItem,
  OpenworkSkillItem,
  OpenworkServerClient,
} from "@/app/lib/openwork-server";

const SCOPE_LABEL: Record<string, string> = {
  project: "Proyecto",
  global: "Global",
  "config.project": "Proyecto",
  "config.global": "Global",
  "config.remote": "Remoto",
  "dir.project": "Proyecto",
  "dir.global": "Global",
  config: "Config",
};

function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {SCOPE_LABEL[scope] ?? scope}
    </span>
  );
}

function SectionHeader({ icon: Icon, title, count }: { icon: typeof Wrench; title: string; count: number }) {
  return (
    <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      {title}
      <span className="text-[10px] font-normal">({count})</span>
    </p>
  );
}

type PersonalizacionPageProps = {
  openworkServerClient: OpenworkServerClient | null;
  workspaceId: string;
};

export function PersonalizacionPage({ openworkServerClient: client, workspaceId }: PersonalizacionPageProps) {
  const skillsQuery = useQuery({
    queryKey: ["personalization-skills", workspaceId],
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      return client.listSkills(workspaceId, { includeGlobal: true });
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 60_000,
  });
  const pluginsQuery = useQuery({
    queryKey: ["personalization-plugins", workspaceId],
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      return client.listPlugins(workspaceId, { includeGlobal: true });
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 60_000,
  });
  const mcpQuery = useQuery({
    queryKey: ["personalization-mcp", workspaceId],
    queryFn: async () => {
      if (!client) throw new Error("not connected");
      return client.listMcp(workspaceId);
    },
    enabled: Boolean(client && workspaceId),
    staleTime: 60_000,
  });

  const skills: OpenworkSkillItem[] = skillsQuery.data?.items ?? [];
  const plugins: OpenworkPluginItem[] = pluginsQuery.data?.items ?? [];
  const mcp: OpenworkMcpItem[] = mcpQuery.data?.items ?? [];

  if (!client) {
    return (
      <Empty variant="ghost" className="h-full">
        <EmptyHeader>
          <EmptyTitle>Servidor no conectado</EmptyTitle>
          <EmptyDescription>Conecta un workspace para ver su personalización.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const loading = skillsQuery.isPending || pluginsQuery.isPending || mcpQuery.isPending;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-lg font-semibold text-foreground">Personalización</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Skills, plugins y conectores MCP que los agentes usan en este workspace.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <>
            <SectionHeader icon={Wrench} title="Skills" count={skills.length} />
            {skillsQuery.isError ? (
              <p className="text-sm text-muted-foreground">Las skills no se pudieron leer.</p>
            ) : skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin skills instaladas.</p>
            ) : (
              <ul className="mb-6 flex flex-col gap-2">
                {skills.map((skill) => (
                  <li key={`${skill.scope}/${skill.name}`} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{skill.name}</p>
                      <ScopeBadge scope={skill.scope} />
                    </div>
                    {skill.description ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{skill.description}</p>
                    ) : null}
                    {skill.error ? <p className="mt-0.5 text-xs text-red-600">{skill.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}

            <SectionHeader icon={Blocks} title="Plugins" count={plugins.length} />
            {pluginsQuery.isError ? (
              <p className="text-sm text-muted-foreground">Los plugins no se pudieron leer.</p>
            ) : plugins.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin plugins instalados.</p>
            ) : (
              <ul className="mb-6 flex flex-col gap-2">
                {plugins.map((plugin) => (
                  <li key={plugin.spec} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{plugin.spec}</p>
                      <ScopeBadge scope={plugin.scope} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <SectionHeader icon={Plug} title="Conectores MCP" count={mcp.length} />
            {mcpQuery.isError ? (
              <p className="text-sm text-muted-foreground">Los conectores no se pudieron leer.</p>
            ) : mcp.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin conectores MCP configurados.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {mcp.map((server) => (
                  <li key={server.name} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{server.name}</p>
                      <ScopeBadge scope={server.source} />
                      {server.disabledByTools ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">deshabilitado</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
