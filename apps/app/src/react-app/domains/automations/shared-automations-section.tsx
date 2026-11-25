/** @jsxImportSource react */
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { formatAutomationSchedule } from "./automation-format"
import { describeAutomationSharingError, filterSharedAutomations } from "./automation-sharing"
import { useSharedAutomationsQuery, type AutomationsDenContext } from "./use-automations"

export function SharedAutomationsSection(props: {
  context: AutomationsDenContext
  search: string
  refresh: () => Promise<void>
  openAutomation: (id: string) => void
}) {
  const sharedQuery = useSharedAutomationsQuery(props.context, true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  const items = filterSharedAutomations(sharedQuery.data?.items ?? [], props.search)
  if (sharedQuery.isLoading) return (
    <div role="status" aria-label="Checking shared Automations" className="space-y-3">
      <Skeleton className="h-5 w-40" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" />
    </div>
  )
  if (sharedQuery.isError) return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm">Shared Automations could not be loaded. Check your connection and try again.</p>
      <Button variant="outline" size="sm" onClick={() => void sharedQuery.refetch()}>Try again</Button>
    </div>
  )
  if (!items.length) return null
  return (
    <section aria-labelledby="shared-automations-heading" className="space-y-3" data-shared-automations>
      <h2 id="shared-automations-heading" className="text-sm font-semibold">Shared with you</h2>
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div key={item.id} className="py-3" data-shared-automation-id={item.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium">{item.name}</h3>
                <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                  <span>Shared by {item.sharedBy.name}</span>
                  <span>{formatAutomationSchedule(item.schedule)}</span>
                  <span>{item.executionTarget === "cloud" ? "Cloud computer" : "Desktop computer"}</span>
                </div>
              </div>
              <Button variant="outline" size="sm" disabled={busyId !== null} onClick={async () => {
                const { client, organizationId } = props.context
                if (!client || !organizationId) return
                setBusyId(item.id)
                setError(null)
                try {
                  const detail = await client.copySharedAutomation(organizationId, item.id)
                  await props.refresh()
                  props.openAutomation(detail.automation.id)
                  toast.success("Added to your Automations. It's paused until you turn it on.")
                } catch (cause) {
                  setError({ id: item.id, message: describeAutomationSharingError(cause, "copy") })
                } finally {
                  setBusyId(null)
                }
              }}>Add to my Automations</Button>
            </div>
            {error?.id === item.id ? <p role="alert" className="mt-2 text-sm text-destructive">{error.message}</p> : null}
          </div>
        ))}
      </div>
    </section>
  )
}
