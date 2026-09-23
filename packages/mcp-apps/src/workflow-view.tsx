import { useEffect, useId, useReducer, useRef, useState } from "react"
import type { AppViewProps } from "./shared/bridge"
import {
  initialWorkflowState, isPreviousResult, runWorkflow, searchWorkflows, selectedWorkflow,
  workflowBlock, workflowKey, workflowReducer, type WorkflowLaunch,
} from "./workflow-state"
import { WorkflowResultView } from "./workflow-result"

export function WorkflowView({ payload, app, hostError }: AppViewProps<WorkflowLaunch>) {
  const [state, dispatch] = useReducer(workflowReducer, payload, initialWorkflowState)
  const [query, setQuery] = useState("")
  const pending = useRef(false)
  const searchId = useId()
  const selectId = useId()
  const blockId = useId()
  const serverTools = Boolean(app.getHostCapabilities()?.serverTools)
  const selected = selectedWorkflow(state)
  const block = workflowBlock(state, serverTools)
  const busy = state.busy !== null
  const canRun = Boolean(selected && !block && !busy && !hostError)

  useEffect(() => { dispatch({ type: "catalog", payload }) }, [payload])

  async function act(operation: "search" | "run") {
    if (pending.current || busy || !serverTools || hostError || (operation === "run" && !canRun)) return
    pending.current = true
    dispatch({ type: "start", operation })
    try {
      if (operation === "search") {
        dispatch({ type: "catalog", payload: await searchWorkflows(app, query) })
      } else if (selected) {
        const result = await runWorkflow(app, selected, Intl.DateTimeFormat().resolvedOptions().timeZone)
        if (result.kind === "workflow_error") dispatch({ type: "error", error: result, operation })
        else dispatch({ type: "result", payload: result, receivedAt: new Date().toISOString() })
      }
    } catch {
      dispatch({ type: "error", operation, error: {
        schemaVersion: "1", kind: "workflow_error", error: "unconfirmed_response",
        message: operation === "run" ? "The run could not be confirmed." : "Workflows could not be refreshed.",
      } })
    } finally {
      pending.current = false
    }
  }

  return <main className="workflows" aria-busy={busy}>
    <header className="workflow-header">
      <h1>Workflows</h1>
      <span className="workflow-muted" role="status">{state.busy === "run" ? "Running" : state.busy === "search" ? "Searching" : hostError || state.error ? "Couldn’t verify" : block ? "Blocked" : "Ready"}</span>
    </header>
    <div className="workflow-search" role="search">
      <label className="sr-only" htmlFor={searchId}>Search workflows</label>
      <input id={searchId} type="search" placeholder="Search workflows" maxLength={200} value={query}
        disabled={busy || !serverTools || Boolean(hostError)} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void act("search") } }} />
      <button type="button" disabled={busy || !serverTools || Boolean(hostError)} onClick={() => void act("search")}>Search</button>
    </div>
    <div className="workflow-picker">
      <label htmlFor={selectId}>Workflow</label>
      <select id={selectId} value={state.selected ? workflowKey(state.selected) : ""}
        disabled={busy || !state.catalog?.workflows.length} aria-describedby={block ? blockId : undefined}
        onChange={event => dispatch({ type: "select", workflow: state.catalog?.workflows.find(workflow => workflowKey(workflow) === event.target.value) ?? null })}>
        <option value="">Choose a workflow</option>
        {state.selected && !selected && <option value={workflowKey(state.selected)}>{state.selected.title} — selected version not in results</option>}
        {state.catalog?.workflows.map(workflow => <option key={workflowKey(workflow)} value={workflowKey(workflow)}>
          {workflow.title}{workflow.blockedReason !== null ? " — Blocked" : ""}
        </option>)}
      </select>
    </div>
    {state.catalog?.hasMore && <p className="workflow-muted">Showing the first {state.catalog.workflows.length} workflows. Narrow your search to find another.</p>}
    {state.catalog?.workflows.length === 0 && <p role="status">No workflows found. Change your search or ask a workflow owner to share access.</p>}
    {block && <p className="workflow-block" id={blockId} role="status">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
      {block}
    </p>}
    {state.selected && <details>
      <summary>Workflow details</summary>
      {(selected ?? state.selected).description && <p>{(selected ?? state.selected).description}</p>}
      <dl><dt>Selected version</dt><dd>{state.selected.configObjectVersionId}</dd></dl>
      <p>Provider writes are denied. Runs still retain receipts.</p>
    </details>}
    <div className="workflow-actions">
      <span className="workflow-muted">Read-only</span>
      <button className="primary" type="button" disabled={!canRun} aria-describedby={block ? blockId : undefined} onClick={() => void act("run")}>Run workflow</button>
    </div>
    {(hostError || state.error) && <section className="workflow-error" role="alert">
      <p>{hostError ?? state.error?.message}</p>
      {!hostError && <p>{state.recovery}</p>}
    </section>}
    {state.result && <WorkflowResultView result={state.result} previous={Boolean(hostError) || isPreviousResult(state)} receivedAt={state.receivedAt} />}
    {!state.result && state.busy === "run" && <section className="workflow-result" role="status" aria-label="Waiting for workflow result">
      <h2>Result: {state.selected?.title}</h2>
      <div className="placeholder" /><div className="placeholder" />
    </section>}
  </main>
}
