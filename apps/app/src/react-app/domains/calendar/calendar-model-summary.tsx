/** @jsxImportSource react */
import { isAutomationCloudDefaultModel, type AutomationModel } from "@openwork/types/automations"
import { AutomationModelSummary } from "@/react-app/domains/automations/automation-model-button"
import { findAutomationModelOption, type AutomationModelOption } from "@/react-app/domains/automations/automation-model-options"
import { ProviderIcon } from "@/react-app/design-system/provider-icon"
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src"

/** Calendar-only presentation; the stored cloud-default model remains unchanged. */
export function CalendarModelSummary(props: {
  model: AutomationModel
  options: readonly AutomationModelOption[]
  polish?: boolean
  organizationDefaultName?: string | null
}) {
  if (!props.polish) return <AutomationModelSummary model={props.model} options={props.options} size="sm" />
  if (!isAutomationCloudDefaultModel(props.model)) {
    const option = findAutomationModelOption(props.options, props.model)
    if (!option) return <span className="text-muted-foreground">Model no longer available</span>
    return (
      <span className="flex min-w-0 items-center gap-2" data-automation-model={`${option.providerId}/${option.modelId}`}>
        <ProviderIcon providerId={option.logoProviderId ?? option.providerId} providerName={option.providerName} size={12} />
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">{option.modelName}</span>
          <span className="text-muted-foreground"> ({option.providerName}{props.model.variant ? `, ${props.model.variant}` : ""})</span>
        </span>
      </span>
    )
  }
  const label = props.organizationDefaultName ? `Organization default (${props.organizationDefaultName})` : "Organization default"
  return (
    <span className="flex min-w-0 items-center gap-2" data-calendar-organization-default data-automation-model={`${props.model.providerId}/${props.model.modelId}`}>
      <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="" aria-hidden="true" className="size-4 shrink-0 dark:invert" />
      <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
    </span>
  )
}
