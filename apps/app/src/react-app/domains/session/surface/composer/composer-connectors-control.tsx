import { ChevronDown, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { connectedFirst, type ComposerConnectorEntry } from "./composer-connections";
import { ConnectorLogo } from "./connector-logo";

const MAX_STACKED_LOGOS = 3;

/**
 * Connectors indicator of the composer: how many MCP servers are connected, and
 * which servers there are. A quiet pill beside the model picker (DESIGN.md T5);
 * the list opens upwards on demand (P3). Nothing to inspect, nothing shown.
 */
export function ComposerConnectorsControl(props: {
  connectors: readonly ComposerConnectorEntry[];
  onOpenChange?: (open: boolean) => void;
  onConnect: (connector: ComposerConnectorEntry) => void;
  onManage: () => void;
}) {
  const { connectors } = props;
  if (connectors.length === 0) return null;
  const ordered = connectedFirst(connectors);
  const connected = ordered.filter((connector) => connector.connected);
  const summary = t("composer.connectors_connected", { count: connected.length });

  return (
    <Popover onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        type="button"
        data-testid="composer-connectors-trigger"
        aria-label={t("composer.connectors_label_named", { summary })}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 px-1.5 text-sm text-muted-foreground @min-[480px]/composer:px-2.5 hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
      >
        {connected.length > 0 ? (
          <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
            {connected.slice(0, MAX_STACKED_LOGOS).map((connector) => (
              <span key={connector.key} className="flex size-5 items-center justify-center rounded-full bg-background ring-1 ring-border">
                <ConnectorLogo connector={connector} />
              </span>
            ))}
          </span>
        ) : null}
        <span>
          <span className="hidden @min-[480px]/composer:inline">{summary}</span>
          <span className="@min-[480px]/composer:hidden">{connected.length}</span>
        </span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        data-testid="composer-connectors-list"
        className="max-h-[min(var(--available-height),20rem)] w-72 max-w-[calc(100vw-2rem)] gap-0 rounded-2xl p-1"
      >
        <ul className="flex flex-col">
          {ordered.map((connector) => (
            <li
              key={connector.key}
              data-connected={connector.connected ? "true" : "false"}
              className={`flex h-8 items-center gap-2 rounded-md px-2 text-sm ${connector.connected ? "text-foreground" : "text-muted-foreground"}`}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <ConnectorLogo connector={connector} />
              </span>
              <span className="min-w-0 flex-1 truncate">{connector.name}</span>
              {connector.signIn ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  disabled={connector.connecting}
                  aria-label={t("composer.plus_connect_named", { name: connector.name })}
                  onClick={() => props.onConnect(connector)}
                >
                  {connector.connecting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
                  {connector.signIn.reconnect ? t("mcp.org_connection_reconnect_action") : t("composer.plus_connect")}
                </Button>
              ) : connector.note ? (
                <span className="shrink-0 text-xs text-gray-9">{connector.note}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" className="mt-1 h-8 justify-start px-2 text-muted-foreground" onClick={props.onManage}>
          {t("composer.plus_manage_connectors")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
