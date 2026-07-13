export type PortableFile = {
  path: string
  content: string
}

export type WorkspaceExportSensitiveMode = "auto" | "include" | "exclude"

export type WorkspaceExportWarning = {
  id: string
  label: string
  detail: string
}

export type WorkspaceExportSkill = {
  name: string
  description?: string
  trigger?: string
  content: string
}

export type WorkspaceExportCommand = {
  name: string
  description?: string
  template?: string
}

export type WorkspaceExportBundle = {
  workspaceId: string
  exportedAt: number
  opencode?: Record<string, unknown>
  openwork?: Record<string, unknown>
  skills?: WorkspaceExportSkill[]
  commands?: WorkspaceExportCommand[]
  files?: PortableFile[]
}

export type WorkspaceImportMode = "merge" | "replace"
export type WorkspaceImportChangeKind = "opencode" | "openwork" | "skill" | "command" | "file"
export type WorkspaceImportChangeAction = "create" | "update" | "replace" | "delete" | "unchanged"

export type WorkspaceImportChange = {
  kind: WorkspaceImportChangeKind
  action: WorkspaceImportChangeAction
  label: string
  path: string
}

export type WorkspaceImportSummary = {
  total: number
  create: number
  update: number
  replace: number
  delete: number
  unchanged: number
}

export type WorkspaceImportPreview = {
  fingerprint: string
  summary: WorkspaceImportSummary
  changes: WorkspaceImportChange[]
}
