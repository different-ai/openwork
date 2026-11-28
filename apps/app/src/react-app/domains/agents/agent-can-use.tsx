import type { PersonalAgentConnectionTools, PersonalAgentToolCatalog } from "@openwork/types/den/personal-agents";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { currentLocale, t } from "@/i18n";

import { AgentConnectionLogo } from "./agent-connection-logo";
import { toolAccessSummary } from "./agent-permission-words";
import type { AgentsRuntime } from "./agents-runtime";
import { useAgentToolsQuery } from "./use-agent-permissions";

function canUse(connection: PersonalAgentConnectionTools): boolean {
  return connection.available && (!connection.blocked || connection.onlyChosenTools) && !connection.lockedByOrganization
    && connection.tools.some((tool) => !tool.lockedByOrganization && tool.access !== "block");
}

export function agentCanUseSummary(catalog: PersonalAgentToolCatalog | undefined, failed = false): string | null {
  if (!catalog) return failed ? t("agents.can_use_unverified") : null;
  const names = catalog.connections.flatMap((connection) => canUse(connection) ? [connection.name] : []);
  if (names.length === 0) return t("agents.can_use_empty");
  const apps = new Intl.ListFormat(currentLocale(), { style: "short", type: "unit" }).format(names.slice(0, 2));
  return names.length > 2 ? t("agents.can_use_more", { apps, count: names.length - 2 }) : apps;
}

export function AgentCanUse({ runtime, agentId, onOpen }: {
  runtime: AgentsRuntime;
  agentId: string;
  onOpen: () => void;
}) {
  const catalog = useAgentToolsQuery(runtime, agentId);
  const summary = agentCanUseSummary(catalog.data, catalog.isError);
  const connections = catalog.data?.connections ?? [];
  const usable = connections.filter(canUse);
  const off = connections.length - usable.length;
  const title = t("agents.permissions_tools");
  return (
    <section data-agent-can-use-list className="flex flex-col">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-agent-can-use="panel"
        aria-label={usable.length > 0 && summary ? `${t("agents.can_use_label")} ${summary}` : title}
        className="h-8 w-full min-w-0 justify-between gap-1 px-1.5 text-dls-secondary hover:bg-dls-hover"
        onClick={onOpen}
      >
        <span className="text-xs font-normal">{title}</span>
        <span className="flex items-center gap-0.5 text-xs font-normal">{t("agents.can_use_manage")}<ChevronRight aria-hidden="true" className="size-3.5" /></span>
        {usable.length === 0 && summary !== null && <span className="sr-only">{summary}</span>}
      </Button>
      {summary === null ? <span aria-hidden="true" className="mx-1.5 my-2 h-7 rounded-lg bg-dls-hover" />
        : usable.length === 0 ? <p className="px-1.5 py-1.5 text-xs leading-5 text-dls-secondary">{summary}</p>
          : <ul>
            {usable.map((connection) => (
              <li key={connection.connectionId} data-agent-can-use-row={connection.name} className="flex min-h-11 items-center gap-2.5 px-1.5 py-1.5">
                <AgentConnectionLogo connectionId={connection.connectionId} name={connection.name} />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-dls-text">{connection.name}</span>
                  <span className="block truncate text-xs text-dls-secondary">{connection.onlyChosenTools && connection.blocked
                    ? t("agents.can_use_only", { count: connection.tools.filter((tool) => tool.chosen !== null && tool.chosen !== "block").length })
                    : toolAccessSummary(connection)}</span>
                </span>
              </li>
            ))}
          </ul>}
      {usable.length > 0 && off > 0 && <p className="px-1.5 pt-1 text-xs text-dls-secondary">{t("agents.can_use_off", { count: off })}</p>}
    </section>
  );
}
