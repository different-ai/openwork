import { ChevronRight, LockKeyhole } from "lucide-react";
import type { AwsAssistants } from "@openwork/types/den/managed-deployments";
import { DenInput } from "../../_components/ui/input";
import { DenSelect } from "../../_components/ui/select";
import { DenSwitch } from "../../_components/ui/switch";

export function ManagedDeploymentAssistants({ value, onChange, enabled, disabled = false, lockReason }: {
  value: AwsAssistants; onChange: (value: AwsAssistants) => void; enabled: boolean; disabled?: boolean; lockReason?: string;
}) {
  const locked = !enabled || disabled;
  return (
    <details className="group text-[13px]" data-testid="deployment-assistant-options">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-[var(--dls-text-primary)]"><ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />Assistants</summary>
      <div className="space-y-4 pt-2">
        {lockReason || !enabled ? <p className="flex items-start gap-2 text-[var(--dls-text-secondary)]"><LockKeyhole aria-hidden className="mt-0.5 size-4 shrink-0" />{lockReason ?? "Managed assistants aren't enabled for this workspace. Ask your OpenWork operator to enable them."}</p> : null}
        <div className="divide-y divide-[var(--dls-border)]">
          <AssistantSwitch label="Managed runner" checked={value.headlessRunnerEnabled} disabled={locked} onChange={(checked) => onChange(checked
            ? { ...value, headlessRunnerEnabled: true, modelProtocol: value.modelProtocol ?? "anthropic" }
            : { ...value, headlessRunnerEnabled: false, workbotEnabled: false, slackAssistantEnabled: false, computerProvider: "off" })} />
          <AssistantSwitch label="Workbot" checked={value.workbotEnabled} disabled={locked || !value.headlessRunnerEnabled} onChange={(checked) => onChange({ ...value, workbotEnabled: checked })} />
          <AssistantSwitch label="Slack assistants" checked={value.slackAssistantEnabled} disabled={locked || !value.headlessRunnerEnabled} onChange={(checked) => onChange({ ...value, slackAssistantEnabled: checked })} />
        </div>
        {value.slackAssistantEnabled ? <p className="text-[var(--dls-text-secondary)]">After installation, create your own Slack app in the installed Den's Connectors. Slack credentials stay in that installation, not hosted OpenWork.</p> : null}
        {value.headlessRunnerEnabled ? <fieldset disabled={locked} className="space-y-4">
          <label className="block space-y-1"><span>Model protocol</span><DenSelect aria-label="Model protocol" value={value.modelProtocol ?? "anthropic"} onChange={(event) => {
            const protocol = event.target.value;
            if (protocol === "anthropic" || protocol === "openai" || protocol === "openai-responses") onChange({ ...value, modelProtocol: protocol });
          }}><option value="anthropic">Anthropic</option><option value="openai">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option></DenSelect></label>
          <label className="block space-y-1"><span>Model HTTPS endpoint</span><DenInput value={value.modelBaseUrl ?? ""} onChange={(event) => onChange({ ...value, modelBaseUrl: event.target.value || undefined })} placeholder="https://model.example.com/v1" /></label>
          <label className="block space-y-1"><span>Model ID</span><DenInput value={value.model ?? ""} onChange={(event) => onChange({ ...value, model: event.target.value || undefined })} /></label>
          <label className="block space-y-1"><span>Model key secret ARN</span><DenInput value={value.modelSecretArn ?? ""} onChange={(event) => onChange({ ...value, modelSecretArn: event.target.value || undefined })} placeholder="arn:aws:secretsmanager:…:secret:…" /></label>
          <p className="text-[var(--dls-text-secondary)]">Create a plain-string secret containing your model API key in this AWS account and region. Enter only its full Secrets Manager ARN, with no JSON field or version suffix. Hosted OpenWork keys and plaintext credentials aren't accepted.</p>
          <label className="block space-y-1"><span>Cloud computers (optional)</span><DenSelect aria-label="Cloud computers (optional)" value={value.computerProvider} onChange={(event) => {
            if (event.target.value === "off" || event.target.value === "daytona" || event.target.value === "freestyle") onChange({ ...value, computerProvider: event.target.value });
          }}><option value="off">Off</option><option value="daytona">Daytona (preferred)</option><option value="freestyle">Freestyle</option></DenSelect></label>
          {value.computerProvider !== "off" ? <>
            <label className="block space-y-1"><span>{value.computerProvider === "daytona" ? "Daytona key secret ARN" : "Freestyle key secret ARN"}</span><DenInput value={value.computerSecretArn ?? ""} onChange={(event) => onChange({ ...value, computerSecretArn: event.target.value || undefined })} placeholder="arn:aws:secretsmanager:…:secret:…" /></label>
            <p className="text-[var(--dls-text-secondary)]">Daytona and Freestyle computers execute outside your AWS account. Create your own provider API key as a plain-string Secrets Manager secret in this AWS account and region; only its ARN is sent to hosted OpenWork.</p>
          </> : null}
          {value.computerProvider === "daytona" ? <>
            <label className="block space-y-1"><span>Daytona computer snapshot</span><DenInput value={value.computerSnapshot ?? ""} onChange={(event) => onChange({ ...value, computerSnapshot: event.target.value || undefined })} /></label>
            <details className="group/daytona"><summary className="flex cursor-pointer list-none items-center gap-2 text-[var(--dls-text-secondary)]"><ChevronRight aria-hidden className="size-4 transition-transform group-open/daytona:rotate-90" />Daytona settings</summary><div className="space-y-4 pt-4">
              <label className="block space-y-1"><span>Daytona HTTPS API endpoint</span><DenInput value={value.daytonaApiUrl ?? "https://app.daytona.io/api"} onChange={(event) => onChange({ ...value, daytonaApiUrl: event.target.value || undefined })} /></label>
              <label className="block space-y-1"><span>Daytona target</span><DenInput value={value.daytonaTarget ?? "us"} onChange={(event) => onChange({ ...value, daytonaTarget: event.target.value || undefined })} /></label>
            </div></details>
          </> : null}
        </fieldset> : null}
      </div>
    </details>
  );
}

function AssistantSwitch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <div className="flex min-h-10 items-center justify-between gap-4 py-2"><span>{label}</span><DenSwitch size="sm" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} /></div>;
}
