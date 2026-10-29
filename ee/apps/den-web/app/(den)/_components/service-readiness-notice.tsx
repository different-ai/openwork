import type { DeploymentCapabilities } from "@openwork/types/den/deployment-capabilities";
import { serviceCheckLine, workbotDeploymentNotice } from "../_lib/service-readiness";
import { DenNotice } from "./ui/notice";

export function ServiceReadinessNotice({ capabilities }: { capabilities?: DeploymentCapabilities }) {
  const notice = workbotDeploymentNotice(capabilities);
  if (!notice) return null;
  const history = serviceCheckLine(notice);
  return (
    <div data-testid="workbot-service-readiness" className="min-w-0">
      <DenNotice tone="neutral" icon={null} message={
        <span className="grid gap-1">
          <span>{notice.message}</span>
          {history ? <span className="text-xs text-[var(--dls-text-secondary)]">{history}</span> : null}
        </span>
      } />
    </div>
  );
}
