/** @jsxImportSource react */
import { CircleAlert, LoaderCircle } from "lucide-react";

import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useSandboxSettings, useSandboxStatus } from "@/react-app/infra/use-sandbox";
import { sandboxEffectiveMode, sandboxPillView } from "@/react-app/kernel/sandbox-chat";

type SandboxPill = NonNullable<ReturnType<typeof sandboxPillView>>;

export function SandboxModePill({ pill, onOpenPermissions }: { pill: SandboxPill | null; onOpenPermissions?: () => void }) {
  if (!pill) return null;
  if (pill.attention) {
    return (
      <Button data-testid="sandbox-mode-pill" variant="ghost" size="xs" className="rounded-full bg-muted text-muted-foreground" title={t("sandbox.attention")} onClick={onOpenPermissions}>
        <CircleAlert aria-hidden="true" />{pill.label}<span className="sr-only">{t("sandbox.attention")}</span>
      </Button>
    );
  }
  return (
    <Badge data-testid="sandbox-mode-pill" variant="secondary" title={pill.step ?? undefined}>
      {pill.step ? <><LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /><span className="sr-only">{pill.step}</span></> : null}
      {pill.label}
    </Badge>
  );
}

export function WorkspaceSandboxModePill({ client, workspaceId, onOpenPermissions }: {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  onOpenPermissions?: () => void;
}) {
  const connection = { client, workspaceId };
  const { settings } = useSandboxSettings(connection);
  const observe = settings.data?.pending === true || sandboxEffectiveMode(settings.data) !== "off";
  const { status } = useSandboxStatus(connection, observe);
  return <SandboxModePill pill={sandboxPillView(settings.data, status.data)} onOpenPermissions={onOpenPermissions} />;
}
