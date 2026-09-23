import type { WorkflowRunnerResult } from "@openwork/types/workflow-runner-app"

type Value = WorkflowRunnerResult["value"]
const previewRows = 5
const previewColumns = 4

function isRecord(value: Value): value is { [key: string]: Value } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function scalar(value: Value | undefined) {
  if (value === undefined || value === null) return "—"
  if (typeof value === "object") return Array.isArray(value) ? `${value.length} items` : "Structured value"
  const text = String(value)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

export function WorkflowValue({ value }: { value: Value }) {
  if (value === null || (typeof value === "string" && !value.trim())) return <p>No value returned. Check the workflow’s source data before running again.</p>
  if (typeof value !== "object") return <p className="workflow-scalar">{scalar(value)}</p>
  const rows: Value[] = Array.isArray(value) ? value : Object.entries(value).map(([field, item]) => ({ Field: field, Value: item }))
  if (rows.length === 0) return <p>No rows returned. Run again after the source data changes.</p>
  const visible = rows.slice(0, previewRows)
  if (visible.every(isRecord)) {
    const fields = [...new Set(visible.flatMap(row => Object.keys(row)))]
    const columns = fields.slice(0, previewColumns)
    if (!columns.length) return <p>No fields returned. Check the workflow’s output with its owner.</p>
    return <>
      <table>
        <caption className="sr-only">Workflow result</caption>
        <thead><tr>{columns.map(column => <th scope="col" key={column}>{scalar(column)}</th>)}</tr></thead>
        <tbody>{visible.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{scalar(row[column])}</td>)}</tr>)}</tbody>
      </table>
      {(rows.length > previewRows || fields.length > previewColumns) && <p className="workflow-muted">Showing {visible.length} of {rows.length} rows and {columns.length} of {fields.length} fields. Full result in Technical details.</p>}
    </>
  }
  return <>
    <table><caption className="sr-only">Workflow result</caption><thead><tr><th scope="col">Value</th></tr></thead>
      <tbody>{visible.map((row, index) => <tr key={index}><td>{scalar(row)}</td></tr>)}</tbody>
    </table>
    {rows.length > previewRows && <p className="workflow-muted">Showing {visible.length} of {rows.length} rows. Full result in Technical details.</p>}
  </>
}

export function WorkflowResultView({ result, previous, receivedAt }: {
  result: WorkflowRunnerResult
  previous: boolean
  receivedAt: string | null
}) {
  return <section className="workflow-result" aria-label={`Result for ${result.workflow.title}`}>
    <div className="workflow-result-heading">
      <h2>{previous ? "Previous result" : "Result"}: {result.workflow.title}</h2>
      {receivedAt && <time className="workflow-muted" dateTime={receivedAt}>Received {new Date(receivedAt).toLocaleTimeString()}</time>}
    </div>
    {previous && <p className="workflow-muted">Not updated for the current selection or attempt.</p>}
    <WorkflowValue value={result.value} />
    <details><summary>Technical details</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
  </section>
}
