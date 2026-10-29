import type { DiagnosticsAttention, OrgDiagnostics } from "@openwork/types/den/diagnostics"
import { SERVICE_LABELS } from "@openwork/types/den/service-readiness"

const MAX_ATTENTION = 200

/**
 * The summary at the top of Settings › Diagnostics, derived only from the
 * sections the caller can see. Errors first; otherwise in section order.
 */
export function deriveDiagnosticsAttention(sections: Pick<OrgDiagnostics, "desktop" | "providers" | "connectors" | "installation">): DiagnosticsAttention[] {
  const items: DiagnosticsAttention[] = []

  if (sections.providers.access === "granted") {
    for (const provider of sections.providers.items) {
      const subject = provider.name
      const base = { section: "providers" as const, targetId: provider.id, subject, count: null, detail: null }
      if (provider.state === "key_rejected") items.push({ ...base, severity: "error", code: "provider_key_rejected", detail: provider.reason })
      else if (provider.state === "unreachable") items.push({ ...base, severity: "error", code: "provider_unreachable", detail: provider.reason })
      else if (provider.state === "misconfigured") items.push({ ...base, severity: "error", code: "provider_misconfigured", detail: provider.reason })
      else if (provider.state === "model_missing") {
        items.push({ ...base, severity: "warning", code: "provider_model_missing", count: provider.models.missing.length, detail: provider.models.missing[0] ?? null })
      }
    }
  }

  if (sections.desktop.access === "granted" && sections.desktop.failed > 0) {
    const common = sections.desktop.failures[0]
    items.push({
      section: "desktop",
      targetId: common?.step ?? "startup",
      severity: "warning",
      code: "desktop_startup_failures",
      subject: "Desktop app",
      count: sections.desktop.failed,
      detail: common?.reason ?? null,
    })
  }

  if (sections.connectors.access === "granted") {
    for (const connector of sections.connectors.items) {
      const base = { section: "connectors" as const, targetId: connector.id, subject: connector.name, count: null, detail: null }
      if (connector.reason === "slack_token_rejected") items.push({ ...base, severity: "error", code: "connector_slack_token_rejected" })
      else if (connector.reason === "slack_not_installed") items.push({ ...base, severity: "warning", code: "connector_slack_not_installed" })
      else if (connector.reason === "google_api_disabled") {
        const disabled = connector.apis.filter((api) => api.status === "disabled")
        items.push({ ...base, severity: "warning", code: "connector_google_api_disabled", count: disabled.length, detail: disabled[0]?.name ?? null })
      }
    }
  }

  if (sections.installation.access === "operator") {
    for (const service of sections.installation.services.services) {
      const base = { section: "installation" as const, targetId: service.id, subject: SERVICE_LABELS[service.id], count: null, detail: service.reason }
      if (service.state === "misconfigured") items.push({ ...base, severity: "error", code: "service_misconfigured" })
      else if (service.state === "unreachable") items.push({ ...base, severity: "error", code: "service_unreachable" })
    }
  }

  const errors = items.filter((item) => item.severity === "error")
  const warnings = items.filter((item) => item.severity === "warning")
  return [...errors, ...warnings].slice(0, MAX_ATTENTION)
}

export function hasDiagnosticsErrors(attention: readonly DiagnosticsAttention[]): boolean {
  return attention.some((item) => item.severity === "error")
}
