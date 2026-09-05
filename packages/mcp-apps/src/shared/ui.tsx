import type { ReactNode } from "react"

export type Tone = "neutral" | "success" | "warning" | "danger" | "info"

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  )
}

export function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  )
}

export function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="m16 6-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  )
}

export function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  )
}

export function AppHeader(props: {
  tone: Tone
  icon: ReactNode
  title: string
  subtitle?: string
  badge?: { tone: Tone; label: string } | null
}) {
  return (
    <header className="header">
      <span className="mark" data-tone={props.tone === "neutral" ? undefined : props.tone} aria-hidden="true">{props.icon}</span>
      <div className="header-copy">
        <h1>{props.title}</h1>
        {props.subtitle ? <p className="subtitle">{props.subtitle}</p> : null}
      </div>
      {props.badge ? (
        <span className="badge" data-tone={props.badge.tone === "neutral" ? undefined : props.badge.tone}>
          {props.badge.label}
        </span>
      ) : null}
    </header>
  )
}

export function CardBody(props: { children: ReactNode }) {
  return <div className="body">{props.children}</div>
}

export function CardFooter(props: { footnote: string; action?: ReactNode }) {
  return (
    <footer className="footer">
      <p className="footnote">{props.footnote}</p>
      {props.action ?? null}
    </footer>
  )
}

export function KeyValueGrid(props: { items: Array<{ label: string; value: string; mono?: boolean }> }) {
  if (props.items.length === 0) return null
  return (
    <dl className="identifiers">
      {props.items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd data-mono={item.mono === true ? "true" : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function StatusCard(props: { children: ReactNode }) {
  return <main className="card card-status">{props.children}</main>
}
