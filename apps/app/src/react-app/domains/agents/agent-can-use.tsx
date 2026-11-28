import type { PersonalAgentToolCatalog } from "@openwork/types/den/personal-agents";

import { Button } from "@/components/ui/button";
import { currentLocale, t } from "@/i18n";

import type { AgentsRuntime } from "./agents-runtime";
import { useAgentToolsQuery } from "./use-agent-permissions";

export function agentCanUseSummary(catalog: PersonalAgentToolCatalog | undefined, failed = false): string | null {
  if (!catalog) return failed ? t("agents.can_use_unverified") : null;
  const names = catalog.connections.flatMap((connection) =>
    connection.available && (!connection.blocked || connection.onlyChosenTools) && !connection.lockedByOrganization
      && connection.tools.some((tool) => !tool.lockedByOrganization && tool.access !== "block")
      ? [connection.name] : [],
  );
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
  const label = t("agents.can_use_label");
  const empty = summary === t("agents.can_use_empty");
  const accessibleLabel = empty || catalog.isError || summary === null
    ? t("agents.permissions_tools") : `${label} ${summary}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-agent-can-use="panel"
      aria-label={accessibleLabel}
      aria-description={empty ? summary : undefined}
      title={empty ? summary : accessibleLabel}
      className="h-9 w-full min-w-0 justify-start gap-1 px-1.5 text-dls-secondary hover:bg-dls-hover"
      onClick={onOpen}
    >
      {!empty && <span className="shrink-0 font-medium">{label}</span>}
      {summary === null
        ? <span aria-hidden="true" className="h-2.5 w-16 rounded-sm bg-dls-hover" />
        : <span className={empty ? "line-clamp-2 whitespace-normal text-start font-normal" : "truncate font-normal"}>{summary}</span>}
    </Button>
  );
}
