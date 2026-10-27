import type { DeploymentCapabilities } from "@openwork/types/den/deployment-capabilities";
import { formatServiceTime, workbotDeploymentNotice } from "../_lib/service-readiness";
import { DenNotice } from "./ui/notice";

export function ServiceReadinessNotice({ capabilities }: { capabilities?: DeploymentCapabilities }) {
  const notice = workbotDeploymentNotice(capabilities);
  if (!notice) return null;
  return (
    <div data-testid="workbot-service-readiness" className="min-w-0">
      <DenNotice tone="neutral" icon={null} message={
        <span className="grid gap-2">
          <span>{notice.message}</span>
          <span className="text-xs">
            {notice.stale ? "Out of date. " : ""}Last checked: {formatServiceTime(notice.checkedAt)}. Last successful check: {formatServiceTime(notice.lastSuccessAt)}.
          </span>
        </span>
      } />
    </div>
  );
}
