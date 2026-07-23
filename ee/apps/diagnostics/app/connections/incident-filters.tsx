"use client"

import { useState, type FormEvent } from "react"
import { CONNECT_DIAGNOSTIC_PHASES } from "@openwork/types/den/connect-diagnostics"

type IncidentFiltersProps = {
  client: string
  code: string
  hours: number
  organization: string
  outcome: string
  phase: string
  source: string
  unstableOnly: boolean
}

export function IncidentFilters(props: IncidentFiltersProps) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const data = new FormData(event.currentTarget)
      const organization = String(data.get("organization") ?? "").trim()
      const client = String(data.get("client") ?? "").trim()
      const response = await fetch("/api/connections/identity", {
        body: JSON.stringify({ organization: organization || undefined, client: client || undefined }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      if (!response.ok) throw new Error("identity lookup failed")
      const identity = await response.json() as {
        organizationHash: string | null
        clientHash: string | null
      }
      const query = new URLSearchParams()
      if (identity.organizationHash) query.set("organization", identity.organizationHash)
      if (identity.clientHash) query.set("client", identity.clientHash)
      for (const name of ["source", "phase", "outcome", "code", "hours"]) {
        const value = String(data.get(name) ?? "").trim()
        if (value) query.set(name, value)
      }
      if (props.unstableOnly) query.set("view", "unstable")
      window.location.assign(`/connections?${query.toString()}`)
    } catch {
      setError("Could not apply the identity filters. Sign in again, then retry.")
      setBusy(false)
    }
  }

  return <>
    <form className="incident-filters" onSubmit={(event) => void submit(event)}>
      <label>Organization ID or hash<input name="organization" defaultValue={props.organization} placeholder="org_… or 64-character hash" /></label>
      <label>Client UUID or hash<input name="client" defaultValue={props.client} placeholder="Optional client filter" /></label>
      <label>Source<select name="source" defaultValue={props.source}><option value="">Both</option><option value="desktop">Desktop</option><option value="den">Den</option></select></label>
      <label>Phase<select name="phase" defaultValue={props.phase}><option value="">All phases</option>{CONNECT_DIAGNOSTIC_PHASES.map((phase) => <option key={phase} value={phase}>{phase.replaceAll("_", " ")}</option>)}</select></label>
      <label>Outcome<select name="outcome" defaultValue={props.outcome}><option value="">All outcomes</option><option value="failure">Failures</option><option value="recovered">Recoveries</option><option value="ok">Healthy</option></select></label>
      <label>Error, network, or HTTP code<input name="code" defaultValue={props.code} placeholder="e.g. ECONNRESET or http_404" /></label>
      <label>Window<select name="hours" defaultValue={String(props.hours)}><option value="6">6 hours</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select></label>
      <button disabled={busy} type="submit">{busy ? "Applying…" : "Apply filters"}</button>
    </form>
    {error ? <p className="filter-error">{error}</p> : null}
  </>
}
