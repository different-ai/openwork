import type { ReactNode } from "react";
import { DenNotice } from "../../_components/ui/notice";

export function WorkflowSharingTab({
  canEdit,
  pluginAccess,
}: {
  canEdit: boolean;
  pluginAccess: ReactNode | null;
}) {
  return (
    <div className="grid gap-6" data-tab="sharing" role="tabpanel" aria-label="Sharing">
      <DenNotice
        tone="neutral"
        message={canEdit ? "You can edit and run this workflow." : "You can run this workflow."}
      />
      {pluginAccess ?? <DenNotice tone="neutral" message="This workflow is shared directly with you." />}
    </div>
  );
}
