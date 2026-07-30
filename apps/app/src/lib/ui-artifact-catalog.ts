import type { UiArtifactKind } from "@openwork/types/ui-artifact"

export type StandardUiArtifactDefinition = {
  artifactId: UiArtifactKind
  labelKey: string
  descriptionKey: string
  category: "overview" | "time" | "communication" | "work"
  sources: readonly string[]
}

export const STANDARD_UI_ARTIFACTS = [
  {
    artifactId: "workspace.brief",
    labelKey: "ui_artifacts.kind.workspace_brief",
    descriptionKey: "ui_artifacts.kind.workspace_brief_desc",
    category: "overview",
    sources: ["OpenWork Connect"],
  },
  {
    artifactId: "widgets.collection",
    labelKey: "ui_artifacts.kind.widgets_collection",
    descriptionKey: "ui_artifacts.kind.widgets_collection_desc",
    category: "overview",
    sources: ["Metrics", "Goals", "Payroll", "Service health"],
  },
  {
    artifactId: "calendar.view",
    labelKey: "ui_artifacts.kind.calendar_view",
    descriptionKey: "ui_artifacts.kind.calendar_view_desc",
    category: "time",
    sources: ["Google Calendar", "Outlook"],
  },
  {
    artifactId: "communication.thread",
    labelKey: "ui_artifacts.kind.communication_thread",
    descriptionKey: "ui_artifacts.kind.communication_thread_desc",
    category: "communication",
    sources: ["Slack", "Teams", "Google Chat"],
  },
  {
    artifactId: "mail.inbox",
    labelKey: "ui_artifacts.kind.mail_inbox",
    descriptionKey: "ui_artifacts.kind.mail_inbox_desc",
    category: "communication",
    sources: ["Gmail", "Outlook"],
  },
  {
    artifactId: "work.attention",
    labelKey: "ui_artifacts.kind.work_attention",
    descriptionKey: "ui_artifacts.kind.work_attention_desc",
    category: "work",
    sources: ["ServiceNow", "Workday", "Tasks"],
  },
  {
    artifactId: "work.approvals",
    labelKey: "ui_artifacts.kind.work_approvals",
    descriptionKey: "ui_artifacts.kind.work_approvals_desc",
    category: "work",
    sources: ["Workday", "ServiceNow"],
  },
] as const satisfies readonly StandardUiArtifactDefinition[]
