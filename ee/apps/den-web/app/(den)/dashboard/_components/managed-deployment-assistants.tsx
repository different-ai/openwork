import { ChevronRight, LockKeyhole } from "lucide-react";
import type { AwsAssistants, AwsRuntimeProfile } from "@openwork/types/den/managed-deployments";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";

export function ManagedDeploymentAssistants({ value, profile, onChange, onUpgrade, enabled, disabled = false, lockReason, openByDefault = false, viaConfiguration = false }: {
  value: AwsAssistants; profile: AwsRuntimeProfile; onChange: (value: AwsAssistants) => void; onUpgrade?: () => void;
  enabled: boolean; disabled?: boolean; lockReason?: string; openByDefault?: boolean;
  /** The gateway runtime is added with Edit configuration on this deployment, not by waiting for an Update. */
  viaConfiguration?: boolean;
}) {
  const locked = !enabled || disabled;
  return (
    <details className="group text-[13px]" data-testid="deployment-assistant-options" open={openByDefault || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-[var(--dls-text-primary)]"><ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />Managed runtime</summary>
      <div className="space-y-4 pt-2">
        {lockReason || !enabled ? <p className="flex items-start gap-2 text-[var(--dls-text-secondary)]"><LockKeyhole aria-hidden className="mt-0.5 size-4 shrink-0" />{lockReason ?? "Gateway-managed runtimes aren't enabled for this workspace. Ask your OpenWork operator to enable them."}</p> : null}
        {profile === "legacy" ? <>
          <IncludedRow label="Runtime profile" value="Legacy" />
          <p className="text-[var(--dls-text-secondary)]">{viaConfiguration
            ? "Existing services are unchanged. Edit configuration can add the model gateway, managed runner, Workbot and Slack/Automations."
            : "Existing services are unchanged. A newer, approved Update can add the model gateway, managed runner, Workbot and Slack/Automations."}</p>
          {onUpgrade && !viaConfiguration ? <DenButton type="button" variant="secondary" disabled={locked} onClick={onUpgrade}>Include gateway runtime in this update</DenButton> : null}
        </> : <>
          <div className="divide-y divide-[var(--dls-border)]" aria-label="Included runtime services">
            {["Den", "Model gateway", "Managed runner", "Workbot", "Slack and Automations"].map((label) => <IncludedRow key={label} label={label} value="Included" />)}
          </div>
          <p className="text-[var(--dls-text-secondary)]" data-testid="deployment-runtime-setup">After first sign-in, configure upstream providers and credentials in Models inside the installed Den. Slack also needs your own app credentials in its Connectors. The runtime isn't ready for model requests until those providers are configured.</p>
          <fieldset disabled={locked} className="space-y-4">
            <label className="block space-y-1"><span>Cloud computers (optional)</span><DenSelect aria-label="Cloud computers (optional)" value={value.computerProvider} onChange={(event) => {
              if (event.target.value === "off" || event.target.value === "daytona" || event.target.value === "freestyle") onChange({ ...value, computerProvider: event.target.value });
            }}><option value="off">Off</option><option value="daytona">Daytona (preferred)</option><option value="freestyle">Freestyle</option></DenSelect></label>
            {value.computerProvider !== "off" ? <>
              <label className="block space-y-1"><span>{value.computerProvider === "daytona" ? "Daytona key secret ARN" : "Freestyle key secret ARN"}</span><DenInput value={value.computerSecretArn ?? ""} onChange={(event) => onChange({ ...value, computerSecretArn: event.target.value || undefined })} placeholder="arn:aws:secretsmanager:…:secret:…" /></label>
              <p className="text-[var(--dls-text-secondary)]">Daytona and Freestyle computers execute outside your AWS account. Create your own provider API key as a plain-string Secrets Manager secret in this AWS account and region; enter only its complete ARN, without a JSON field or version suffix.</p>
            </> : null}
            {value.computerProvider === "daytona" ? <>
              <label className="block space-y-1"><span>Daytona computer snapshot</span><DenInput value={value.computerSnapshot ?? ""} onChange={(event) => onChange({ ...value, computerSnapshot: event.target.value || undefined })} /></label>
              <details className="group/daytona"><summary className="flex cursor-pointer list-none items-center gap-2 text-[var(--dls-text-secondary)]"><ChevronRight aria-hidden className="size-4 transition-transform group-open/daytona:rotate-90" />Daytona settings</summary><div className="space-y-4 pt-4">
                <label className="block space-y-1"><span>Daytona HTTPS API endpoint</span><DenInput value={value.daytonaApiUrl ?? "https://app.daytona.io/api"} onChange={(event) => onChange({ ...value, daytonaApiUrl: event.target.value || undefined })} /></label>
                <label className="block space-y-1"><span>Daytona target</span><DenInput value={value.daytonaTarget ?? "us"} onChange={(event) => onChange({ ...value, daytonaTarget: event.target.value || undefined })} /></label>
              </div></details>
            </> : null}
          </fieldset>
        </>}
      </div>
    </details>
  );
}

function IncludedRow({ label, value }: { label: string; value: string }) {
  return <div className="flex min-h-10 items-center justify-between gap-4 py-2"><span>{label}</span><span className="text-[var(--dls-text-secondary)]">{value}</span></div>;
}
