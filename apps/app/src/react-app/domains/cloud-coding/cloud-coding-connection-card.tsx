import type { ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import type { DenClient } from "@/app/lib/den";
import { openDesktopUrlWithStatus } from "@/app/lib/desktop";
import { ServiceMark, GITHUB_SERVICE_MARK } from "@/components/ui/service-mark";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function CloudCodingConnectionCard({ scope, dismiss, fallback, openUrl = openDesktopUrlWithStatus }: {
  scope: { client: Pick<DenClient, "getCloudCodingOverview" | "requestCloudCodingAdmin">; denBaseUrl: string; organizationId: string; principal: string };
  dismiss: () => void;
  fallback: ReactNode;
  openUrl?: (url: string) => Promise<unknown>;
}) {
  const permissions = useQuery({
    queryKey: [scope.denBaseUrl, "cloud-coding-overview", scope.organizationId, scope.principal],
    queryFn: () => scope.client.getCloudCodingOverview(scope.organizationId),
    staleTime: 30_000,
    retry: false,
  });
  const canManage = permissions.data?.canManage;
  const ask = useMutation({ mutationFn: () => scope.client.requestCloudCodingAdmin(scope.organizationId) });
  const connect = useMutation({ mutationFn: () => openUrl(new URL("/dashboard/cloud-coding", scope.denBaseUrl).toString()) });

  if (canManage === undefined || permissions.isError) return fallback;
  return <section data-testid="desktop-connection-card" aria-label={t("cloud_coding.github_connection")} aria-live="polite" className="w-full max-w-full self-start text-sm text-foreground">
    <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-3 px-3 py-1">
      <ServiceMark name="GitHub" iconUrl={GITHUB_SERVICE_MARK} />
      <p role="status" className="flex min-w-0 flex-1 items-center gap-2 font-medium">
        {!canManage && <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />}
        {t(canManage ? "cloud_coding.connect_title" : "cloud_coding.admin_needed")}
      </p>
      {canManage ? <Button type="button" size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>{t("cloud_coding.connect")}</Button> : <>
        {ask.isSuccess ? <span className="text-xs text-muted-foreground">{t("cloud_coding.admin_asked")}</span>
          : <Button type="button" size="sm" variant="outline" disabled={ask.isPending} onClick={() => ask.mutate()}>
            {t(ask.isError ? "tool_approvals.retry" : "cloud_coding.ask_admin")}
          </Button>}
        <Button type="button" variant="ghost" size="sm" onClick={dismiss}>{t("cloud_coding.dismiss")}</Button>
      </>}
    </div>
    {(ask.isError || connect.isError) && <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
      {t(ask.isError ? "cloud_coding.admin_request_failed" : "cloud_coding.dashboard_open_failed")}
    </p>}
  </section>;
}
