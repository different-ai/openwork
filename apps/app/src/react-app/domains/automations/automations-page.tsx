/** @jsxImportSource react */
import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowLeft,
  CalendarClock,
  Cloud,
  History,
  Monitor,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
} from "lucide-react"
import { useNavigate, useSearchParams } from "react-router"
import type {
  AutomationDetail,
  AutomationRun,
  AutomationRunEvent,
  AutomationSchedule,
  AutomationState,
  CreateAutomation,
} from "@openwork/types/automations"
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"

import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/sonner"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider"
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal"
import { AutomationEditor } from "./automation-editor"
import { dispatchAutomationsStateChanged } from "./automation-events"
import { automationExecutionThreadRoute, automationExecutionIdentity, automationLocalSessionRoute } from "./automation-cloud-thread"
import { formatAutomationSchedule, formatAutomationTime } from "./automation-format"
import type { AutomationProviderCatalog } from "./automation-model-options"
import { automationModelOptions, describeAutomationModel } from "./automation-model-options"

const ACTIVE_RUN_STATUSES = new Set<AutomationRun["status"]>(["queued", "claimed", "running"])
const AUTOMATIONS_PAGE_FAST_POLL_MS = 10_000
const AUTOMATIONS_PAGE_SLOW_POLL_MS = 60_000

function stateLabel(state: AutomationState) {
  if (state === "needs_attention") return "Needs attention"
  return state.slice(0, 1).toUpperCase() + state.slice(1)
}

function stateVariant(state: AutomationState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "active") return "default"
  if (state === "needs_attention") return "destructive"
  return state === "inactive" ? "secondary" : "outline"
}

function runVariant(status: AutomationRun["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "default"
  if (status === "failed") return "destructive"
  if (ACTIVE_RUN_STATUSES.has(status)) return "secondary"
  return "outline"
}

function runLabel(run: AutomationRun) {
  if (run.status === "skipped" && run.error?.code === "runner_unavailable") {
    // Den names the cause it observed — no desktop, a busy desktop, or one
    // that stayed silent. Older receipts predate that and carry the single
    // generic wording, so fall back rather than restate it for every cause.
    return run.error.message.trim() || "Missed — desktop runner unavailable"
  }
  if (run.status === "skipped" && (run.error?.code === "model_access_lost" || run.error?.code === "provider_unavailable")) {
    return "Skipped — model unavailable"
  }
  return run.status
}

function ExecutionIcon({ run }: { run: AutomationRun }) {
  return run.executionThread?.executionLocation === "desktop"
    ? <Monitor className="size-3" />
    : <Cloud className="size-3" />
}

function describeError(error: unknown) {
  if (error instanceof DenApiError) {
    if (error.status === 401 || error.status === 403) return "Sign in to the selected Den organization to access Automations."
    if (error.status === 404) return "This Automation is no longer available."
    return error.message
  }
  return error instanceof Error ? error.message : "Automations could not be loaded."
}

function inputFromDetail(detail: AutomationDetail): CreateAutomation {
  return {
    name: detail.automation.name,
    instructions: detail.revision.instructions,
    schedule: detail.revision.schedule,
    model: detail.revision.model,
  }
}

function eventSummary(event: AutomationRunEvent) {
  const payload = event.payload
  const preferred = ["message", "text", "summary", "name", "warning", "error"]
    .flatMap((key) => typeof payload[key] === "string" ? [payload[key]] : [])
    .at(0)
  if (preferred) return preferred
  const serialized = JSON.stringify(payload)
  return serialized === "{}" ? "No additional details." : serialized
}

function usageLabel(run: AutomationRun) {
  const input = run.usage.inputTokens === null ? "—" : run.usage.inputTokens.toLocaleString()
  const output = run.usage.outputTokens === null ? "—" : run.usage.outputTokens.toLocaleString()
  const cost = run.usage.costMicros === null ? "—" : `$${(run.usage.costMicros / 1_000_000).toFixed(4)}`
  return `${input} input · ${output} output · ${cost}`
}

function LoadingState() {
  return (
    <div className="space-y-4 p-6" role="status" aria-label="Loading Automations">
      <Skeleton className="h-14 rounded-2xl" />
      <Skeleton className="h-40 rounded-2xl" />
      <Skeleton className="h-40 rounded-2xl" />
    </div>
  )
}

export function AutomationsPage(props: { providerCatalog?: AutomationProviderCatalog; workspaceId?: string | null } = {}) {
  const denAuth = useDenAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState(false)
  const [repairingModel, setRepairingModel] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)

  const settings = readDenSettings()
  const organizationId = settings.activeOrgId?.trim() || null
  const token = settings.authToken?.trim() || null
  const client = useMemo(
    () => token ? createDenClient({ baseUrl: settings.baseUrl, token }) : null,
    [settings.baseUrl, token],
  )
  const selectedId = searchParams.get("automation")?.trim() || null
  const selectedRunId = searchParams.get("run")?.trim() || null
  const selectedThreadId = searchParams.get("thread")?.trim() || null
  const creating = searchParams.get("create") === "1"
  const ready = denAuth.isSignedIn && Boolean(client && organizationId)
  const queryRoot = ["den", "automations", organizationId]
  const zenModelRestricted = useDesktopRestriction("allowZenModel")
  const freeStarterInRuntime = props.providerCatalog === undefined || Boolean(
    props.providerCatalog[AUTOMATION_FREE_MODEL.providerId]?.[AUTOMATION_FREE_MODEL.modelId],
  )

  const listQuery = useQuery({
    queryKey: [...queryRoot, "list"],
    queryFn: () => client!.listAutomations(organizationId!, { limit: 100 }),
    enabled: ready,
    refetchInterval: AUTOMATIONS_PAGE_SLOW_POLL_MS,
  })
  const providersQuery = useQuery({
    queryKey: [...queryRoot, "models"],
    queryFn: () => client!.listOrgLlmProviders(organizationId!),
    enabled: ready,
  })
  const runnerPresenceQuery = useQuery({
    queryKey: [...queryRoot, "runner-presence"],
    queryFn: () => client!.getAutomationDesktopRunnerPresence(organizationId!),
    enabled: ready,
    // A failed probe waits for the next interval instead of retrying, and a
    // Den without the route answers null once — there is nothing to poll.
    retry: false,
    refetchInterval: (queryState) => (queryState.state.data === null ? false : 60_000),
  })
  // Only a Den that positively reports no desktop earns the warning. A Den too
  // old to answer, or one that has not answered yet, leaves presence unknown,
  // and claiming there is no desktop on that basis would be worse than silence.
  const noDesktopConnected = runnerPresenceQuery.data?.connected === false
  const detailQuery = useQuery({
    queryKey: [...queryRoot, "detail", selectedId],
    queryFn: () => client!.getAutomation(organizationId!, selectedId!),
    enabled: ready && Boolean(selectedId),
  })
  const runsQuery = useQuery({
    queryKey: [...queryRoot, "runs", selectedId],
    queryFn: () => client!.listAutomationRuns(organizationId!, selectedId!, { limit: 100 }),
    enabled: ready && Boolean(selectedId),
    refetchInterval: (queryState) => queryState.state.data?.items.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
      ? AUTOMATIONS_PAGE_FAST_POLL_MS
      : AUTOMATIONS_PAGE_SLOW_POLL_MS,
  })
  const receiptQuery = useQuery({
    queryKey: [...queryRoot, "receipt", selectedRunId],
    queryFn: () => client!.getAutomationRun(organizationId!, selectedRunId!),
    enabled: ready && Boolean(selectedRunId),
    refetchInterval: (queryState) => {
      const run = queryState.state.data?.run
      return run && ACTIVE_RUN_STATUSES.has(run.status) ? AUTOMATIONS_PAGE_FAST_POLL_MS : false
    },
  })

  const models = useMemo(
    () => automationModelOptions(providersQuery.data ?? [], {
      includeFreeStarter: !zenModelRestricted && freeStarterInRuntime,
    }),
    [freeStarterInRuntime, providersQuery.data, zenModelRestricted],
  )
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const items = listQuery.data?.items.filter((item) => item.automation.state !== "archived") ?? []
    if (!normalized) return items
    return items.filter((item) => (
      item.automation.name.toLowerCase().includes(normalized)
      || item.revision.instructions.toLowerCase().includes(normalized)
    ))
  }, [listQuery.data, query])

  const openAutomation = (automationId: string | null) => {
    const next = new URLSearchParams()
    if (automationId) next.set("automation", automationId)
    setSearchParams(next)
    setEditing(false)
    setRepairingModel(false)
  }
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryRoot })
    dispatchAutomationsStateChanged()
  }
  const act = async (key: string, action: () => Promise<void>, success: string) => {
    setBusyAction(key)
    try {
      await action()
      await refresh()
      toast.success(success)
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setBusyAction(null)
    }
  }

  if (denAuth.status === "checking") return <LoadingState />
  if (!denAuth.isSignedIn) {
    return (
      <div className="mx-auto max-w-xl p-6 pt-16">
        <Alert variant="warning">
          <Cloud aria-hidden="true" />
          <AlertTitle>Sign in to Den to use Automations</AlertTitle>
          <AlertDescription>
            Den keeps Automation schedules and history. Cloud Automations can run while Desktop is offline; Desktop Automations run when this signed-in app is connected.
          </AlertDescription>
        </Alert>
      </div>
    )
  }
  if (!organizationId || !client) {
    return (
      <div className="mx-auto max-w-xl p-6 pt-16">
        <Alert variant="warning">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Select a Den organization</AlertTitle>
          <AlertDescription>Automations belong to your active Den organization.</AlertDescription>
        </Alert>
      </div>
    )
  }
  if (listQuery.isLoading) return <LoadingState />
  if (listQuery.error) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 p-6 pt-16 text-center" role="alert">
        <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
        <div>
          <h2 className="font-medium">Automations unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">{describeError(listQuery.error)}</p>
        </div>
        <Button variant="outline" onClick={() => void listQuery.refetch()}><RefreshCw />Retry</Button>
      </div>
    )
  }

  if (creating) {
    return (
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Back to Automations" onClick={() => openAutomation(null)}>
            <ArrowLeft />
          </Button>
          <div>
            <h2 className="text-xl font-semibold">Create Automation</h2>
            <p className="text-sm text-muted-foreground">It becomes active as soon as you create it.</p>
          </div>
        </div>
        <AutomationEditor
          busy={busyAction === "create"}
          modelOptions={models}
          providerCatalog={props.providerCatalog}
          submitLabel="Create and activate"
          onCancel={() => openAutomation(null)}
          onSave={async (input) => {
            setBusyAction("create")
            try {
              // Pin the workspace the person is creating from; targeting must
              // not follow whichever workspace happens to be active at run time.
              const workspaceId = props.workspaceId?.trim() || null
              const detail = await client.createAutomation(organizationId, {
                ...input,
                ...(workspaceId ? { workspaceId } : {}),
              })
              await refresh()
              openAutomation(detail.automation.id)
              toast.success("Automation created and active")
            } catch (error) {
              toast.error(describeError(error))
            } finally {
              setBusyAction(null)
            }
          }}
        />
      </div>
    )
  }

  if (selectedId) {
    if (detailQuery.isLoading) return <LoadingState />
    if (detailQuery.error || !detailQuery.data) {
      return (
        <div className="mx-auto max-w-xl space-y-4 p-6 pt-16 text-center">
          <AlertCircle className="mx-auto size-8 text-destructive" />
          <p>{describeError(detailQuery.error)}</p>
          <Button variant="outline" onClick={() => openAutomation(null)}>Back to Automations</Button>
        </div>
      )
    }
    const detail = detailQuery.data
    const task = detail.automation
    const modelNeedsAttention = task.needsAttentionReason?.code === "model_access_lost"
      || task.needsAttentionReason?.code === "provider_unavailable"
    const runs = runsQuery.data?.items ?? []
    const selectedReceipt = receiptQuery.data?.run.id === selectedRunId ? receiptQuery.data : undefined
    const receiptIsLoading = receiptQuery.isLoading || (receiptQuery.isFetching && !selectedReceipt)
    const threadMatches = !selectedThreadId || selectedReceipt?.run.executionThread?.id === selectedThreadId
    const localSessionRoute = selectedReceipt?.run.executionThread
      ? automationLocalSessionRoute(selectedReceipt.run.executionThread)
      : null

    if (editing && (detail.revision.executionTarget ?? "desktop") === "desktop") {
      return (
        <div className="mx-auto max-w-3xl space-y-5 p-6">
          <div>
            <h2 className="text-xl font-semibold">Edit Automation</h2>
            <p className="text-sm text-muted-foreground">Saving creates an immutable revision for future runs.</p>
          </div>
          <AutomationEditor
            initial={inputFromDetail(detail)}
            initialKey={detail.revision.id}
            busy={busyAction === "update"}
            openModelPickerOnMount={repairingModel}
            modelOptions={models}
            providerCatalog={props.providerCatalog}
            submitLabel="Save changes"
            onCancel={() => {
              setEditing(false)
              setRepairingModel(false)
            }}
            onSave={async (input) => {
              setBusyAction("update")
              try {
                await client.updateAutomation(organizationId, task.id, input)
                await refresh()
                setEditing(false)
                setRepairingModel(false)
                toast.success("Automation updated")
              } catch (error) {
                toast.error(describeError(error))
              } finally {
                setBusyAction(null)
              }
            }}
          />
        </div>
      )
    }

    return (
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <Button variant="ghost" size="icon" aria-label="Back to Automations" onClick={() => openAutomation(null)}>
              <ArrowLeft />
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold">{task.name}</h2>
                <Badge variant={stateVariant(task.state)}>{stateLabel(task.state)}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{formatAutomationSchedule(detail.revision.schedule)}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(detail.revision.executionTarget ?? "desktop") === "desktop" ? <Button variant="outline" onClick={() => {
              setRepairingModel(false)
              setEditing(true)
            }}><Pencil />Edit</Button> : null}
            {task.state === "active" ? (
              <Button
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => void act("deactivate", async () => {
                  await client.deactivateAutomation(organizationId, task.id)
                }, "Automation deactivated. A run already in progress will continue.")}
              >
                <Square />Deactivate
              </Button>
            ) : task.state === "inactive" ? (
              <Button
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => void act("activate", async () => {
                  await client.activateAutomation(organizationId, task.id)
                }, "Automation activated")}
              >
                <Play />Activate
              </Button>
            ) : null}
            <Button
              disabled={busyAction !== null || task.state === "archived" || task.state === "needs_attention"}
              onClick={() => void act("run", async () => {
                const run = await client.runAutomationNow(organizationId, task.id)
                const next = new URLSearchParams({ automation: task.id, run: run.id })
                setSearchParams(next)
              }, "Automation queued")}
            >
              <Play />Run now
            </Button>
            <Button variant="ghost" size="icon" aria-label="Archive Automation" onClick={() => setArchiveOpen(true)}>
              <Archive />
            </Button>
          </div>
        </div>

        {(detail.revision.executionTarget ?? "desktop") === "desktop"
          && task.state === "active"
          && noDesktopConnected ? (
          <Alert variant="warning" data-automation-runner-offline>
            <AlertCircle />
            <AlertTitle>No desktop connected</AlertTitle>
            <AlertDescription>
              <p>
                This Automation runs on your desktop, and Den cannot see one right now. Occurrences that
                come due are recorded as missed unless a signed-in desktop is running by then.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {task.needsAttentionReason ? (
          <Alert variant="warning" data-automation-model-attention={modelNeedsAttention || undefined}>
            {modelNeedsAttention ? <AlertTriangle /> : <AlertCircle />}
            <AlertTitle>{modelNeedsAttention ? "Model needs attention" : "Action required"}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{task.needsAttentionReason.message}</p>
              {modelNeedsAttention && (detail.revision.executionTarget ?? "desktop") === "desktop" ? (
                <>
                  <p>This Automation is paused. Its instructions, schedule, and run history are unchanged.</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRepairingModel(true)
                      setEditing(true)
                    }}
                  >
                    Select a supported model
                  </Button>
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
          <div className="space-y-5">
            <Card variant="outline">
              <CardHeader>
                <CardTitle>Instructions</CardTitle>
                <CardDescription>Revision {detail.revision.version}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm leading-6">{detail.revision.instructions}</p>
              </CardContent>
            </Card>

            <Card variant="outline">
              <CardHeader>
                <CardTitle>{detail.revision.executionTarget === "cloud" ? "OpenWork Cloud execution" : "Desktop execution"}</CardTitle>
                <CardDescription>{detail.revision.executionTarget === "cloud" ? "Den wakes the Cloud runtime and runs this task headlessly without a desktop." : "Den keeps the schedule and durable history; your connected desktop runs the task locally."}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="min-w-0"><span className="text-muted-foreground">Model</span><p className="break-words">{describeAutomationModel(detail.revision.model, models)}</p></div>
                <div className="min-w-0"><span className="text-muted-foreground">Next run</span><p className="break-words">{task.state === "needs_attention" ? "No future run scheduled" : formatAutomationTime(task.nextDueAt)}</p></div>
                <div className="min-w-0"><span className="text-muted-foreground">Runtime limit</span><p className="break-words">{Math.round(detail.revision.maximumRuntimeMs / 60_000)} minutes</p></div>
                <div className="min-w-0"><span className="text-muted-foreground">Integrations</span><p className="break-words">Your available OpenWork Connect tools</p></div>
              </CardContent>
            </Card>

            <Card variant="outline">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><History className="size-4" />Run history</CardTitle>
                <CardDescription>Durable receipts for manual and scheduled runs.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {runsQuery.isLoading ? <Skeleton className="h-24 rounded-xl" /> : null}
                {!runsQuery.isLoading && runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
                {runs.map((run) => (
                  <div
                    key={run.id}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-border p-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant={runVariant(run.status)}>{runLabel(run)}</Badge>
                        <span className="text-xs text-muted-foreground">{run.trigger}</span>
                        {run.executionThread ? (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <ExecutionIcon run={run} />{automationExecutionIdentity(run.executionThread).label}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">{formatAutomationTime(run.startedAt ?? run.createdAt)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {!ACTIVE_RUN_STATUSES.has(run.status) ? <span className="text-xs text-muted-foreground">{usageLabel(run)}</span> : null}
                      {ACTIVE_RUN_STATUSES.has(run.status) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => void act(`cancel:${run.id}`, async () => {
                            await client.cancelAutomationRun(organizationId, run.id)
                          }, "Run cancellation requested")}
                        >Cancel</Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (run.executionThread) navigate(automationExecutionThreadRoute(run.executionThread))
                          else setSearchParams(new URLSearchParams({ automation: task.id, run: run.id }))
                        }}
                      >Open</Button>
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card variant="outline" className="h-fit">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Monitor className="size-4" />Execution thread</CardTitle>
              <CardDescription>{selectedRunId ? "Run receipt and event timeline" : "Select a run to inspect its execution thread."}</CardDescription>
            </CardHeader>
            <CardContent>
              {!selectedRunId ? (
                <div className="py-10 text-center text-sm text-muted-foreground">No run selected.</div>
              ) : receiptIsLoading ? (
                <Skeleton className="h-48 rounded-xl" />
              ) : receiptQuery.error || !selectedReceipt ? (
                <Alert variant="warning"><AlertCircle /><AlertDescription>{describeError(receiptQuery.error)}</AlertDescription></Alert>
              ) : !threadMatches ? (
                <Alert variant="warning"><AlertCircle /><AlertDescription>This Cloud thread no longer matches the selected run.</AlertDescription></Alert>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={runVariant(selectedReceipt.run.status)}>{runLabel(selectedReceipt.run)}</Badge>
                    {selectedReceipt.run.executionThread ? (
                      <Badge variant="outline"><ExecutionIcon run={selectedReceipt.run} />{automationExecutionIdentity(selectedReceipt.run.executionThread).label}</Badge>
                    ) : selectedReceipt.run.status === "queued" ? (
                      <Badge variant="outline">{selectedReceipt.run.executionTarget === "cloud" ? "Waiting for OpenWork Cloud" : "Waiting for desktop runner"}</Badge>
                    ) : (
                      <Badge variant="outline">{selectedReceipt.run.executionTarget === "cloud" ? <Cloud className="mr-1 h-3 w-3" /> : <Monitor className="mr-1 h-3 w-3" />}{selectedReceipt.run.executionTarget === "cloud" ? "OpenWork Cloud" : "Desktop"}</Badge>
                    )}
                    {localSessionRoute ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-automation-run-id={selectedReceipt.run.id}
                        onClick={() => navigate(localSessionRoute)}
                      >
                        Open local thread
                      </Button>
                    ) : null}
                  </div>
                  {selectedReceipt.run.error ? (
                    <Alert variant="destructive"><AlertCircle /><AlertTitle>{selectedReceipt.run.error.code}</AlertTitle><AlertDescription>{selectedReceipt.run.error.message}</AlertDescription></Alert>
                  ) : null}
                  {selectedReceipt.run.resultSummary ? (
                    <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Result</p><p className="mt-1 whitespace-pre-wrap text-sm">{selectedReceipt.run.resultSummary}</p></div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">{usageLabel(selectedReceipt.run)}</div>
                  <ol className="space-y-3 border-s border-border ps-4">
                    {selectedReceipt.events.map((event) => (
                      <li key={event.id} className="relative">
                        <span className="absolute -start-[1.2rem] top-1.5 size-2 rounded-full bg-muted-foreground" />
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium">{event.type.replaceAll("_", " ")}</span>
                          <time className="text-xs text-muted-foreground">{formatAutomationTime(event.createdAt)}</time>
                        </div>
                        <p className="mt-1 break-words text-xs text-muted-foreground">{eventSummary(event)}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <ConfirmModal
          open={archiveOpen}
          variant="danger"
          title="Archive Automation?"
          message="Future runs will stop. Durable run history will remain available in Den."
          confirmLabel="Archive"
          cancelLabel="Cancel"
          onCancel={() => setArchiveOpen(false)}
          onConfirm={() => {
            setArchiveOpen(false)
            void act("archive", async () => {
              await client.archiveAutomation(organizationId, task.id)
              openAutomation(null)
            }, "Automation archived")
          }}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Automations</h2>
          <p className="mt-1 text-sm text-muted-foreground">Scheduled durably in Den, with each Automation executed in its fixed Desktop or OpenWork Cloud location.</p>
        </div>
        <Button onClick={() => setSearchParams(new URLSearchParams({ create: "1" }))}><Plus />New Automation</Button>
      </div>
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-9" value={query} placeholder="Search Automations" onChange={(event) => setQuery(event.currentTarget.value)} />
      </div>
      {filteredItems.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarClock /></EmptyMedia>
            <EmptyTitle>{query ? "No matching Automations" : "No Automations yet"}</EmptyTitle>
            <EmptyDescription>{query ? "Try a different search." : "Create a Desktop Automation here; it runs while this signed-in desktop is connected. Create headless Cloud Automations from Web or Cloud Chat."}</EmptyDescription>
          </EmptyHeader>
          {!query ? <EmptyContent><Button onClick={() => setSearchParams(new URLSearchParams({ create: "1" }))}><Plus />New Automation</Button></EmptyContent> : null}
        </Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filteredItems.map((item) => (
            <button
              key={item.automation.id}
              type="button"
              data-automation-id={item.automation.id}
              {...(item.automation.state === "needs_attention" ? { "data-automation-needs-attention": true } : {})}
              className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40"
              onClick={() => openAutomation(item.automation.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 truncate font-medium">
                    {item.automation.state === "needs_attention" ? (
                      <AlertTriangle className="size-4 shrink-0 text-warning" aria-label="Automation needs attention" />
                    ) : null}
                    <span className="truncate">{item.automation.name}</span>
                  </h3>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.revision.instructions}</p>
                </div>
                <Badge variant={stateVariant(item.automation.state)}>{stateLabel(item.automation.state)}</Badge>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{formatAutomationSchedule(item.revision.schedule)}</span>
                <span>{item.latestRun ? `Last run: ${item.latestRun.status}` : `Next: ${formatAutomationTime(item.automation.nextDueAt)}`}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
