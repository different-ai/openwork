"use client";

import { LockKeyhole } from "lucide-react";
import { useId, useState } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenSwitch } from "../../../_components/ui/switch";
import { permissionLockReason } from "../../../_lib/den-org";
import { ItemSection } from "../../_components/item-list";
import { SavedUndoLine, SettingRow } from "../../_components/scoped-setting";
import { hairline, secondaryText } from "./computer-parts";
import { useOrganizationComputerRules, useSaveComputerRunCodeRule } from "./computer-rules-data";
import { onOff } from "./inventory-format";
import { RemoteAccessSetting } from "./remote-access-setting";

const RUN_CODE_LABEL = "Agents on other computers can run code on members' computers";
const SANDBOX_REASON = "OpenWork can't run arriving work outside the sandbox on personal computers yet, so this can't be turned off.";

function LockedRuleIcon() {
  return <LockKeyhole size={16} strokeWidth={1.5} aria-hidden="true" className={`shrink-0 ${secondaryText}`} />;
}

function RunCodeRule({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const query = useOrganizationComputerRules(orgId);
  const save = useSaveComputerRunCodeRule(orgId);
  const [saved, setSaved] = useState<{ previous: boolean | null; current: boolean } | null>(null);
  const labelId = useId();
  const lockId = `${labelId}-lock`;
  const stateId = `${labelId}-state`;
  const permissionReason = canEdit ? null : permissionLockReason("organization.update");
  const data = query.data;
  const current = data?.rules.runCode;
  const shown = save.isPending ? save.variables ?? current : current;
  const followsTasks = data?.runCodeChosen === false;
  const choice = followsTasks ? null : current;
  const undo = canEdit && saved && choice === saved.current ? () => void change(saved.previous, true) : undefined;

  async function change(next: boolean | null, undoing: boolean) {
    if (!canEdit || choice === undefined || choice === next || save.isPending) return;
    try {
      const updated = await save.mutateAsync(next);
      setSaved(undoing ? null : { previous: choice, current: updated.rules.runCode });
    } catch {
      return;
    }
  }

  return <div className={`border-b ${hairline}`} aria-busy={save.isPending || query.isPending}>
    <SettingRow flush label={RUN_CODE_LABEL} labelId={labelId} aside={permissionReason ? <LockedRuleIcon /> : undefined}
      stateLine={permissionReason || followsTasks ? <>
        {permissionReason ? <span className="block" id={lockId}>{permissionReason}</span> : null}
        {followsTasks ? <span className="block" id={stateId}>This follows the tasks setting until you choose On or Off here.</span> : null}
      </> : undefined}>
      {shown === undefined ? query.isError ? <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>
        : <DenSkeleton className="h-5 w-16" /> : <>
        <span className={`text-xs ${secondaryText}`}>{onOff(shown)}</span>
        <DenSwitch size="sm" aria-label={RUN_CODE_LABEL} aria-describedby={permissionReason ? lockId : followsTasks ? stateId : undefined}
          checked={shown} disabled={!canEdit || save.isPending} onChange={(next) => void change(next, false)} testId="computer-rules-run-code" />
      </>}
    </SettingRow>
    {query.error ? <div className="flex items-center justify-between gap-2 pb-2" role="alert">
      <p className={`text-xs ${secondaryText}`}>{query.error.message}{data ? " Showing the last known rule." : ""}</p>
      {data ? <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton> : null}
    </div> : null}
    {save.error ? <p role="alert" className="pb-2 text-xs text-[var(--ow-danger)]">{save.error.message}</p> : null}
    {saved && choice === saved.current ? <SavedUndoLine message="Saved." pending={save.isPending} onUndo={undo} /> : null}
  </div>;
}

function scrollToComputersAnchor(node: HTMLDivElement | null) {
  if (!node || window.location.hash !== "#computers") return;
  requestAnimationFrame(() => {
    if (node.isConnected && window.location.hash === "#computers") node.scrollIntoView({ block: "start" });
  });
}

export function ComputerRulesSection({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const sandboxId = useId();
  return <div ref={scrollToComputersAnchor} id="computers" data-testid="computer-rules" className="mt-6 scroll-mt-6">
    <ItemSection variant="rule" title="Computers">
      <RemoteAccessSetting orgId={orgId} hideSectionHeading />
      <RunCodeRule orgId={orgId} canEdit={canEdit} />
      <div className={`border-b ${hairline}`}>
        <SettingRow flush label="Work arriving on personal computers runs in the sandbox" labelId={sandboxId} stateLine={SANDBOX_REASON}>
          <span className={`text-xs ${secondaryText}`}>Required</span><LockedRuleIcon />
        </SettingRow>
      </div>
    </ItemSection>
  </div>;
}
