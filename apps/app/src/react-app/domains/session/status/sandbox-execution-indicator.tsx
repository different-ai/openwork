/** @jsxImportSource react */
import { LoaderCircle, ShieldCheck, ShieldX } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { useSandboxSettings } from "@/react-app/infra/use-sandbox-settings";
import type { OpenworkServerClient, OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import { sandboxExecutionIndicatorState } from "./sandbox-execution-state";

export function SandboxExecutionIndicator({ client, workspaceId, status, enabled }: {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  status: OpenworkServerStatus;
  enabled: boolean;
}) {
  const settings = useSandboxSettings({ client, workspaceId, enabled: enabled && status === "connected" });
  const indicator = sandboxExecutionIndicatorState(settings.data, enabled && status === "connected");
  if (!indicator) return null;
  const Icon = indicator.state === "starting" ? LoaderCircle : indicator.state === "unavailable" ? ShieldX : ShieldCheck;
  return (
    <Tooltip>
      <TooltipTrigger render={(
        <span
          className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground titlebar-no-drag"
          data-testid="session-sandbox-indicator"
          data-sandbox-state={indicator.state}
          role="status"
          tabIndex={0}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span>{t(indicator.label)}</span>
        </span>
      )} />
      <TooltipContent>{t(indicator.detail)}</TooltipContent>
    </Tooltip>
  );
}
