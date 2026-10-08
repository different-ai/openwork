/** @jsxImportSource react */
import { useState } from "react"
import type { AutomationList } from "@openwork/types/automations"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { AutomationEditor } from "@/react-app/domains/automations/automation-editor"
import type { AutomationProviderCatalog } from "@/react-app/domains/automations/automation-model-options"
import { automationEditChoices, type useAutomationEditorSetup } from "@/react-app/domains/automations/use-automation-editor-setup"
import { describeAutomationError, useAutomationActions, type AutomationsDenContext } from "@/react-app/domains/automations/use-automations"

type AutomationListItem = AutomationList["items"][number]

/**
 * Edit an Automation from the Calendar with the Automations page's own editor: name, instructions, when it
 * repeats, the model, and what it can use (which decides where it runs). Saving a new place moves it there.
 */
export function CalendarEditDialog(props: {
  item: AutomationListItem
  context: AutomationsDenContext
  setup: ReturnType<typeof useAutomationEditorSetup>
  providerCatalog?: AutomationProviderCatalog
  workspaceId: string | null
  onOpenProviderSettings?: () => void
  onClose: () => void
}) {
  const { automation, revision } = props.item
  const { busyAction, setBusyAction, refresh } = useAutomationActions(props.context)
  const [error, setError] = useState<string | null>(null)
  const current = revision.executionTarget ?? "desktop"
  const { setup } = props

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose() }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" data-calendar-edit={automation.id}>
        <DialogHeader>
          <DialogTitle>Edit automation</DialogTitle>
          <DialogDescription>Saving applies to future runs.</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <AutomationEditor
          onOpenProviderSettings={props.onOpenProviderSettings}
          placement={current}
          placementChoices={automationEditChoices(current, setup.placementChoices)}
          cloudOptions={setup.cloudOptions}
          onThisComputer={isDesktopRuntime()}
          connectedAccounts={setup.connectedAccounts}
          initial={{ name: automation.name, instructions: revision.instructions, schedule: revision.schedule, model: revision.model }}
          initialKey={revision.id}
          busy={busyAction === "update"}
          modelOptions={setup.modelsFor(current)}
          modelOptionsByPlacement={setup.modelsByPlacement}
          providerCatalog={props.providerCatalog}
          submitLabel="Save changes"
          onCancel={props.onClose}
          onSave={async (input, chosen) => {
            const { client, organizationId } = props.context
            if (!client || !organizationId) return
            setBusyAction("update")
            setError(null)
            try {
              const workspaceId = isDesktopRuntime() ? props.workspaceId?.trim() || null : null
              await client.updateAutomation(organizationId, automation.id, chosen === current ? input : {
                ...input,
                executionTarget: chosen,
                // Moving to the desktops pins it to this workspace, as creating here does.
                ...(chosen === "desktop" && workspaceId ? { workspaceId } : {}),
              })
              await refresh()
              toast.success(chosen === current ? "Automation updated" : chosen === "cloud" ? "Automation moved to the cloud" : "Automation moved to your desktop")
              props.onClose()
            } catch (caught) {
              setError(describeAutomationError(caught))
            } finally {
              setBusyAction(null)
            }
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
