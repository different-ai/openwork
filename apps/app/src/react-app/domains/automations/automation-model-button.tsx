/** @jsxImportSource react */
import { AlertTriangle, ChevronDown, Cloud } from "lucide-react"
import type { AutomationModel } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ProviderIcon } from "@/react-app/design-system/provider-icon"
import { findAutomationModelOption, type AutomationModelOption } from "./automation-model-options"

/** The provider's logo, model name and provider for an Automation's model; shared by the editor's button and read-only rows. */
export function AutomationModelSummary(props: { model: AutomationModel; options: readonly AutomationModelOption[]; size?: "sm" | "default" }) {
  const option = findAutomationModelOption(props.options, props.model)
  const small = props.size === "sm"
  if (!option) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
        <span className="truncate">{props.model.providerId}/{props.model.modelId} · no longer available</span>
      </span>
    )
  }
  return (
    <span className="flex min-w-0 items-center gap-2" data-automation-model={`${option.providerId}/${option.modelId}`}>
      <span className={cn("grid shrink-0 place-items-center rounded-md bg-background ring-1 ring-border", small ? "size-5" : "size-6")}>
        {option.accessKind === "cloud_default"
          ? <Cloud className={small ? "size-3" : "size-3.5"} aria-hidden="true" />
          : <ProviderIcon providerId={option.logoProviderId ?? option.providerId} providerName={option.providerName} size={small ? 12 : 14} />}
      </span>
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{option.modelName}</span>
        <span className="text-muted-foreground"> · {option.providerName}</span>
        {props.model.variant ? <span className="text-muted-foreground"> · {props.model.variant}</span> : null}
      </span>
    </span>
  )
}

/** Opens the model picker; shows the current model with its provider's logo. */
export function AutomationModelButton(props: {
  id?: string
  model: AutomationModel
  options: readonly AutomationModelOption[]
  size?: "sm" | "default"
  onClick: () => void
}) {
  return (
    <Button
      id={props.id}
      type="button"
      variant="outline"
      className={cn("w-full justify-between gap-2 font-normal", props.size === "sm" ? "h-8 px-2" : "h-10 px-2.5")}
      onClick={props.onClick}
    >
      <AutomationModelSummary model={props.model} options={props.options} size={props.size} />
      <ChevronDown className="size-4 shrink-0 opacity-60" />
    </Button>
  )
}
